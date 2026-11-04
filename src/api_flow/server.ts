// Entry point that registers every account.
//
// SERVER_MODE=selector (default) drives a browser through the event pages. Accounts are the
// profiles/<id>.txt files; each account signs in manually once in its own browser profile
// (chrome_profiles/<id>), no cookies are used.
//
// SERVER_MODE=api calls Luma's registration API directly. Accounts come from COOKIES_ACCOUNT_<ID>
// entries in config.txt or environment variables (env wins), each with a profiles/<id>.txt file.
// The cookie value can be the full "Cookie" header copied from the browser or just the value
// of luma.auth-session-key.
import * as fs from "fs";
import path from "path";
import { readConfig, readProfile } from "./config";
import {
    isLumaSessionValid,
    normalizeLumaCookie,
    printRunSummary,
    runRegistrationForAccount,
} from "./lumaRunner";
import { runSelectorRegistrationForAccount } from "../old_selector_flow/selectorRunner";
import { CloudflareChallengeError } from "../old_selector_flow/cloudflare";
import { BrowserClosedError } from "../old_selector_flow/browserClosed";

const PROFILES_DIR = path.resolve(__dirname, "../../profiles");
const COOKIE_KEY_PREFIX = "COOKIES_ACCOUNT_";

interface Account {
    id: string;
    cookieString: string | null; // API mode only
    profileFile: string;
}

// Selector mode: one account per profiles/<id>.txt
function discoverProfileAccounts(): Account[] {
    if (!fs.existsSync(PROFILES_DIR)) return [];
    return fs
        .readdirSync(PROFILES_DIR)
        .filter((file) => file.endsWith(".txt"))
        .sort()
        .map((file) => ({ id: file.slice(0, -4).toLowerCase(), cookieString: null, profileFile: path.join(PROFILES_DIR, file) }));
}

function discoverAccounts(config: Record<string, string>): { accounts: Account[]; errors: string[] } {
    const accounts: Account[] = [];
    const errors: string[] = [];
    const cookieValues: Record<string, string> = {};
    for (const source of [config, process.env]) {
        for (const [key, value] of Object.entries(source)) {
            if (key.startsWith(COOKIE_KEY_PREFIX) && value) {
                cookieValues[key] = value;
            }
        }
    }

    for (const cookieKey of Object.keys(cookieValues).sort()) {
        const id = cookieKey.slice(COOKIE_KEY_PREFIX.length).toLowerCase();
        const cookieString = normalizeLumaCookie(cookieValues[cookieKey]);
        const profileFile = path.join(PROFILES_DIR, `${id}.txt`);
        if (!cookieString) {
            errors.push(`${cookieKey}: no luma.auth-session-key found in the value.`);
        } else if (!fs.existsSync(profileFile)) {
            errors.push(`${cookieKey}: profile file ${path.relative(process.cwd(), profileFile)} is missing.`);
        } else {
            accounts.push({ id, cookieString, profileFile });
        }
    }
    return { accounts, errors };
}

const DEFAULT_MAX_RUN_MINUTES = 240;

async function main(): Promise<number> {
    const config = await readConfig();
    // MAX_RUN_MINUTES: a run that hangs anyway ends here. On Railway the next scheduled run is skipped while
    // the previous one is still going, and a frozen headless Chrome can burn CPU for hours.
    const maxRunMinutes = parseInt(process.env.MAX_RUN_MINUTES || config["MAX_RUN_MINUTES"] || "", 10) || DEFAULT_MAX_RUN_MINUTES;
    setTimeout(() => {
        console.error(`\x1b[31mRun still going after ${maxRunMinutes} minutes, stopping it. The next run picks up the remaining events.\x1b[0m`);
        process.exit(0);
    }, maxRunMinutes * 60 * 1000).unref();
    const mode = (process.env.SERVER_MODE || config["SERVER_MODE"] || "selector").toLowerCase();
    console.log(`Server mode: ${mode}`);
    const discovered = mode === "api" ? discoverAccounts(config) : { accounts: discoverProfileAccounts(), errors: [] };
    const errors = discovered.errors;
    // ONLY_ACCOUNTS=one,two limits the run to some accounts
    const only = (process.env.ONLY_ACCOUNTS || "").split(",").map((id) => id.trim().toLowerCase()).filter(Boolean);
    const accounts = only.length > 0 ? discovered.accounts.filter((a) => only.includes(a.id)) : discovered.accounts;
    errors.forEach((error) => console.error(`\x1b[31m${error}\x1b[0m`));

    if (accounts.length === 0) {
        console.error(
            mode === "api"
                ? `\x1b[31mNo usable accounts. Set ${COOKIE_KEY_PREFIX}<ID> in config.txt or env vars and add profiles/<id>.txt files.\x1b[0m`
                : `\x1b[31mNo usable accounts. Add profiles/<id>.txt files.\x1b[0m`
        );
        return 1;
    }
    console.log(`Found ${accounts.length} account(s): ${accounts.map((a) => a.id).join(", ")}`);

    let hadFailure = errors.length > 0;
    for (const account of accounts) {
        console.log(`\n========== Account "${account.id}" ==========`);
        try {
            const profile = await readProfile(account.profileFile);
            let result;
            if (mode === "api") {
                if (!account.cookieString || !(await isLumaSessionValid(account.cookieString))) {
                    console.error(`\x1b[31mLuma session for account "${account.id}" is invalid or expired. Update ${COOKIE_KEY_PREFIX}${account.id.toUpperCase()}.\x1b[0m`);
                    hadFailure = true;
                    continue;
                }
                result = await runRegistrationForAccount(account.cookieString, profile, config, account.id);
            } else {
                result = await runSelectorRegistrationForAccount(profile, config, account.id);
            }
            console.log(`\n--- Finished account "${account.id}" ---`);
            printRunSummary(result);
        } catch (error) {
            hadFailure = true;
            if (error instanceof BrowserClosedError) {
                console.error(`\x1b[31m${error.message}\x1b[0m`);
                break;
            }
            if (error instanceof CloudflareChallengeError) {
                console.error(`\x1b[31m${error.message} Remaining accounts are skipped until the next run.\x1b[0m`);
                // An expected stop, not a crash: a failing exit code makes Railway restart the container right
                // away, which hits the same challenge again from the same IP
                hadFailure = false;
                break;
            }
            console.error(`\x1b[31mAccount "${account.id}" failed:\x1b[0m`, error);
        }
    }

    return hadFailure ? 1 : 0;
}

main().then((code) => process.exit(code));
