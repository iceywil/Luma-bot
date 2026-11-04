// Selector-flow run for one account: registers through the event pages like `npm run selector` does.
//
// No cookies are injected: each account has its own browser profile, and you sign in manually in it
// the first time (the login is then kept in the profile for the next runs).
// - Default: the real Chrome is started as a plain process with chrome_profiles/<id> and Patchright
//   only attaches to it over CDP (no automation flags, real history and Cloudflare cookies). Patchright,
//   unlike Playwright, doesn't enable the Runtime domain or add window.__playwright__binding__, so the
//   page and Turnstile's iframe can't tell it is attached (check with `npm run leak-test patchright`).
// - BROWSER_MODE=playwright (or no Chrome installed): Playwright + stealth with chrome_profiles/<id>-playwright.
//
// The bot fills each form and clicks Submit itself, with a human-like mouse path, while Patchright stays
// attached. If Luma's Turnstile still asks for a captcha, you solve it in the window (visible browser only).
// MANUAL_SUBMIT=true only fills the forms: you submit them, and the bot watches Luma's status for the event
// from its own background tab (statusProbe.ts) to move on once the application shows up, or when you
// close the tab.
//
// Closing the browser (or the calendar tab) stops the whole run.
import { spawn } from "child_process";
import * as fs from "fs";
import path from "path";
import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import { BrowserContext, Page } from "playwright";
import { chromium as undetectedChromium } from "patchright";
import { getBrowserConfig, chromeLaunchArgs } from "../api_flow/browserConfig";
import { AccountRunResult, normalizeLumaCookie } from "../api_flow/lumaRunner";
import { processEventPage } from "./eventProcessor";
import { pagesAwaitingManualSubmit } from "./modalHandler";
import { waitOutCloudflareChallenge, CloudflareChallengeError } from "./cloudflare";
import { BrowserClosedError, isBrowserClosedError } from "./browserClosed";
import { browserCommand, captureAccount } from "../cli/getCookies";
import { openStatusProbe, SUBMITTED_STATUSES } from "./statusProbe";

chromium.use(stealth());

const EVENT_LINK_SELECTOR = "a.event-link";
// A single event page shows one of these action buttons instead of a grid of event links.
const EVENT_PAGE_SELECTOR = 'button:has-text("Register"), button:has-text("Get Ticket"), button:has-text("Join Waitlist"), button:has-text("Request to Join"), button:has-text("One-Click")';
const CHROME_PROFILES_DIR = path.resolve(__dirname, "../../chrome_profiles");

// Uses the configured system browser when installed, otherwise Playwright's bundled Chromium (Docker image).
function resolveExecutablePath(config: Record<string, string>): string | undefined {
    try {
        const { executablePath } = getBrowserConfig(config["BROWSER"]);
        return fs.existsSync(executablePath) ? executablePath : undefined;
    } catch {
        return undefined;
    }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface OpenedBrowser {
    context: BrowserContext;
    close: () => Promise<void>;
    // Called once if the browser goes away without the bot closing it (the user closed it)
    onClosedByUser: (listener: () => void) => void;
    // Real Chrome only: while the user submits on `page`, waits until Luma shows the application for
    // eventApiId (then closes the tab), the user closes the tab, or waitMs passes.
    waitForSubmit?: (page: Page, waitMs: number, eventApiId: string | null) => Promise<SubmitOutcome>;
}

type SubmitOutcome =
    | { kind: "submitted"; status: string } // Luma has the application
    | { kind: "tab closed" } // closed by the user, no application seen
    | { kind: "timed out" };

// Starts the real Chrome with the account's own profile and attaches Patchright to it over CDP.
async function openRealChrome(executablePath: string, profileDir: string, headless: boolean): Promise<OpenedBrowser> {
    let closing = false;
    const closedListeners: (() => void)[] = [];
    const notifyClosed = () => !closing && closedListeners.forEach((listener) => listener());

    const port = 9400 + Math.floor(Math.random() * 500);
    const endpoint = `http://127.0.0.1:${port}`;
    const chrome = spawn(
        executablePath,
        [
            `--user-data-dir=${profileDir}`,
            `--remote-debugging-port=${port}`,
            "--no-first-run",
            "--no-default-browser-check",
            ...chromeLaunchArgs(executablePath, headless),
            "about:blank",
        ],
        { stdio: "ignore" }
    );
    let exited = false;
    chrome.on("exit", (code, signal) => {
        exited = true;
        if (!closing) console.warn(`  Chrome exited (code ${code}, signal ${signal}).`);
        notifyClosed();
    });
    for (let waited = 0; ; waited += 500) {
        if (exited) throw new Error(`Chrome exited on startup. Is the profile ${profileDir} already open in another window?`);
        if (waited > 30000) throw new Error("Chrome did not open its DevTools port within 30s.");
        if (await fetch(`${endpoint}/json/version`).then((r) => r.ok, () => false)) break;
        await sleep(500);
    }
    const waitForExit = async () => {
        for (let waited = 0; !exited && waited < 10000; waited += 250) await sleep(250);
        if (!exited) chrome.kill();
    };

    const browser = await undetectedChromium.connectOverCDP(endpoint);
    browser.on("disconnected", () => {
        if (!closing) console.warn("  Lost the connection to Chrome.");
        notifyClosed();
    });

    return {
        // Patchright's types are those of a newer Playwright, the rest of the flow uses Playwright's
        context: browser.contexts()[0] as unknown as BrowserContext,
        onClosedByUser: (listener) => closedListeners.push(listener),
        waitForSubmit: async (page, waitMs, eventApiId) => {
            const probe = eventApiId ? await openStatusProbe(port).catch(() => null) : null;
            const submittedStatus = async () => {
                const status = probe && eventApiId ? await probe.status(eventApiId) : null;
                return status && SUBMITTED_STATUSES.includes(status) ? status : null;
            };
            let outcome: SubmitOutcome = { kind: "timed out" };
            try {
                for (const deadline = Date.now() + waitMs; !exited && Date.now() < deadline; ) {
                    await sleep(3000);
                    if (page.isClosed()) {
                        const status = await submittedStatus();
                        outcome = status ? { kind: "submitted", status } : { kind: "tab closed" };
                        break;
                    }
                    const status = await submittedStatus();
                    if (status) {
                        outcome = { kind: "submitted", status };
                        await sleep(1500); // let the confirmation show
                        await page.close().catch(() => {});
                        break;
                    }
                }
            } finally {
                await probe?.close();
            }
            return outcome;
        },
        close: async () => {
            if (exited) return;
            closing = true;
            // Close Chrome cleanly so the profile isn't marked as crashed
            await browserCommand(port, "Browser.close").catch(() => chrome.kill());
            await waitForExit();
        },
    };
}

async function openBrowser(config: Record<string, string>, accountId: string): Promise<OpenedBrowser> {
    const headless = config["HEADLESS"] !== "false";
    const executablePath = resolveExecutablePath(config);
    if (config["BROWSER_MODE"] !== "playwright" && executablePath) {
        const profileDir = path.join(CHROME_PROFILES_DIR, accountId);
        if (!headless) {
            // Sign in (if needed) in a plain Chrome window with nothing attached to the page: Cloudflare's
            // Turnstile on the sign-in page fails while Playwright is attached.
            console.log(`Checking the Luma login in a plain Chrome window (sign in there if asked)...`);
            if (!(await captureAccount(accountId, 9330, executablePath, false))) {
                throw new BrowserClosedError();
            }
        }
        console.log(`Opening real Chrome with profile ${path.relative(process.cwd(), profileDir)}${headless ? " (headless)" : ""}...`);
        return openRealChrome(executablePath, profileDir, headless);
    }

    const profileDir = path.join(CHROME_PROFILES_DIR, `${accountId}-playwright`);
    console.log(`Launching Playwright + stealth${executablePath ? ` (${executablePath})` : ""} with profile ${path.relative(process.cwd(), profileDir)}...`);
    const context = await chromium.launchPersistentContext(profileDir, {
        headless,
        executablePath,
        args: ["--disable-blink-features=AutomationControlled"],
        locale: "en-US",
        timezoneId: config["TIMEZONE"] || undefined,
    });
    let closing = false;
    return {
        context,
        onClosedByUser: (listener) => context.on("close", () => !closing && listener()),
        close: async () => {
            closing = true;
            await context.close().catch(() => {});
        },
    };
}

const LOGIN_WAIT_MS = 10 * 60 * 1000;

// If the browser isn't logged into Luma: use the account's COOKIES_ACCOUNT_<ID> session when there is one
// (a fresh profile, e.g. in Docker, where the Mac profile's cookies can't be decrypted), otherwise open the
// sign-in page and wait for a manual login (visible browser only).
async function ensureLoggedIn(page: Page, context: BrowserContext, config: Record<string, string>, accountId: string): Promise<void> {
    const loggedIn = async () =>
        (await context.cookies("https://luma.com")).some((c) => c.name === "luma.auth-session-key");
    if (await loggedIn()) return;
    const cookieKey = `COOKIES_ACCOUNT_${accountId.toUpperCase()}`;
    const session = normalizeLumaCookie(process.env[cookieKey] || config[cookieKey] || "");
    if (session) {
        console.log(`Profile not logged into Luma, using the session from ${cookieKey}.`);
        const expires = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
        await context.addCookies(
            session.split("; ").map((part) => {
                const separator = part.indexOf("=");
                return { name: part.slice(0, separator), value: part.slice(separator + 1), domain: ".luma.com", path: "/", secure: true, httpOnly: true, sameSite: "Lax" as const, expires };
            })
        );
        if (await loggedIn()) return;
    }
    if (config["HEADLESS"] !== "false") {
        throw new Error(`Browser profile is not logged into Luma. Run once with HEADLESS=false to sign in manually, or set ${cookieKey}.`);
    }
    console.warn("\x07\x1b[33mNot logged into Luma in this browser. Log in in the Chrome window (waiting up to 10 min)...\x1b[0m");
    await page.goto("https://luma.com/signin", { waitUntil: "load" });
    await page.bringToFront().catch(() => {});
    for (const deadline = Date.now() + LOGIN_WAIT_MS; Date.now() < deadline; ) {
        await page.waitForTimeout(2000);
        if (await loggedIn()) {
            console.log("  Logged in, continuing.");
            return;
        }
    }
    throw new Error("Timed out waiting for the manual Luma login.");
}

const randomBetween = (min: number, max: number) => min + Math.floor(Math.random() * (max - min));

const DEFAULT_EVENT_TIMEOUT_SECONDS = 480;

class EventTimeoutError extends Error {}

// Resolves like `work`, or rejects with EventTimeoutError after `ms`. A page can freeze for good (seen with
// Turnstile using all the CPU headless): calls into it then never return, so nothing else would end the wait.
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new EventTimeoutError(`no result after ${ms / 1000}s`)), ms);
    });
    // The abandoned work may still fail later (its page gets closed): that must not crash the process
    work.catch(() => {});
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

const isAtBottom = (page: Page) =>
    page.evaluate(() => window.innerHeight + window.scrollY >= document.body.scrollHeight - 5);

// Scrolls about half a screen down like a person: small mouse-wheel ticks with short random pauses.
async function scrollABit(page: Page): Promise<void> {
    const distance = (await page.evaluate(() => window.innerHeight)) * (randomBetween(40, 70) / 100);
    // Wheel events need the mouse over the page
    await page.mouse.move(randomBetween(300, 600), randomBetween(300, 500));
    for (let scrolled = 0; scrolled < distance; ) {
        const tick = randomBetween(80, 200);
        await page.mouse.wheel(0, tick);
        scrolled += tick;
        await page.waitForTimeout(randomBetween(60, 180));
    }
    await page.waitForTimeout(randomBetween(600, 1500)); // "reading" pause, also lets lazy loading kick in
}

// Event links currently on screen, top to bottom
const visibleEventLinks = (page: Page) =>
    page.$$eval(EVENT_LINK_SELECTOR, (els) =>
        els
            .filter((el) => {
                const rect = el.getBoundingClientRect();
                return rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
            })
            .map((el) => (el as HTMLAnchorElement).href)
            .filter(Boolean)
    );

export async function runSelectorRegistrationForAccount(
    profile: Record<string, string>,
    config: Record<string, string>,
    accountId: string = "local"
): Promise<AccountRunResult> {
    const result: AccountRunResult = { successfulRegistrations: [], processingFailures: [], stoppedEarly: false };

    // One or more calendars, separated by commas: EVENT_CALENDAR_URL=https://luma.com/a,https://luma.com/b
    const calendarUrls = (config["EVENT_CALENDAR_URL"] || "").split(/[,\s]+/).filter(Boolean);
    if (calendarUrls.length === 0) {
        throw new Error("EVENT_CALENDAR_URL not set. Add it to config.txt or as an environment variable.");
    }
    const dryRun = config["DRY_RUN"] === "true";

    const browser = await openBrowser(config, accountId);
    let closedByUser = false;
    let shuttingDown = false;
    browser.onClosedByUser(() => {
        closedByUser = true;
        console.warn("\x1b[33mBrowser closed. Stopping the run.\x1b[0m");
    });
    // MANUAL_SUBMIT=true: the bot fills each form and you submit it
    const manualSubmit = config["MANUAL_SUBMIT"] === "true";
    const manualSubmitWaitMs = (parseInt(config["MANUAL_SUBMIT_WAIT_SECONDS"] || "", 10) || 600) * 1000;
    // EVENT_TIMEOUT_SECONDS: one event (open, fill, submit, captcha) never takes longer than this
    const eventTimeoutMs = (parseInt(config["EVENT_TIMEOUT_SECONDS"] || "", 10) || DEFAULT_EVENT_TIMEOUT_SECONDS) * 1000;
    try {
        const context = browser.context;
        const page = context.pages()[0] ?? (await context.newPage());
        // Closing the calendar tab also stops the run
        page.on("close", () => {
            if (shuttingDown) return;
            console.warn("  The calendar tab was closed.");
            closedByUser = true;
        });
        const stopIfClosed = () => {
            if (closedByUser) throw new BrowserClosedError();
        };

        // Lets the user submit the filled form in `eventPage`. True once Luma has the application.
        const waitForManualSubmit = async (eventPage: Page): Promise<boolean> => {
            console.warn(
                `\x07\x1b[33mForm filled on ${eventPage.url()}. Check it, click Submit and solve the captcha: the bot continues once Luma has the application (waiting up to ${manualSubmitWaitMs / 1000}s, close the tab to skip this event)...\x1b[0m`
            );
            await eventPage.bringToFront().catch(() => {});
            if (!browser.waitForSubmit) {
                // Playwright mode: no status probe, closing the tab means done
                return eventPage.waitForEvent("close", { timeout: manualSubmitWaitMs }).then(() => true, () => false);
            }
            const eventApiId = (await eventPage.content()).match(/"(?:event_)?api_id"\s*:\s*"(evt-[a-zA-Z0-9]+)"/)?.[1] ?? null;
            if (!eventApiId) console.warn("  Could not find the event id: can't detect the submit, close the tab when done.");
            const outcome = await browser.waitForSubmit(eventPage, manualSubmitWaitMs, eventApiId);
            stopIfClosed();
            if (outcome.kind === "submitted") console.log(`  Application received by Luma (${outcome.status}), continuing.`);
            else if (outcome.kind === "tab closed") console.log("  Tab closed without an application, skipping this event.");
            else console.log("  No application in time, moving on (the tab stays open).");
            return outcome.kind === "submitted";
        };

        await ensureLoggedIn(page, context, config, accountId);

        // MAX_EVENTS=5 stops after the first 5 events (test batches), all calendars together
        const maxEventsSetting = parseInt(config["MAX_EVENTS"] || "", 10);
        const maxEvents = Number.isNaN(maxEventsSetting) ? Infinity : maxEventsSetting;
        if (dryRun) console.log("DRY_RUN=true: listing events only, nothing is submitted in selector mode.");

        // Shared by the calendars, so an event listed on several is processed once
        const seen = new Set<string>();
        const skipped = new Set<string>();
        const eventKey = (link: string) => link.split(/[?#]/)[0].toLowerCase();
        // A direct event link (luma.com/<slug>) rather than a calendar, so a listed URL can be a single event.
        const isLumaLink = (link: string) => /^https:\/\/(www\.)?(luma\.com|lu\.ma)\//.test(link);
        // Register for one event page; shared by the calendar grid and by direct event links.
        const registerOneEvent = async (link: string): Promise<void> => {
            console.log(`\n--- Processing Event ${seen.size}: ${link} ---`);
            try {
                const eventConfig = { ...config, ACCOUNT_ID: accountId, MANUAL_SUBMIT: String(manualSubmit) };
                let ok = await withTimeout(processEventPage(page, context, link, eventConfig, profile), eventTimeoutMs);
                const awaiting = context.pages().find((p) => pagesAwaitingManualSubmit.has(p) && !p.isClosed());
                if (awaiting) ok = await waitForManualSubmit(awaiting);
                (ok ? result.successfulRegistrations : result.processingFailures).push(link);
            } catch (error) {
                if (error instanceof CloudflareChallengeError) result.processingFailures.push(`${link} (Cloudflare challenge)`);
                if (!(error instanceof EventTimeoutError)) throw error;
                console.error(`\x1b[31m  Event ${link} stuck (${error.message}), giving up on it and closing its tab.\x1b[0m`);
                result.processingFailures.push(`${link} (stuck)`);
                // Close every tab but the calendar; a frozen one may not even answer that
                for (const other of context.pages().filter((p) => p !== page)) {
                    await withTimeout(other.close({ runBeforeUnload: false }), 15000).catch(() => {});
                }
            }
            stopIfClosed();
            await page.bringToFront().catch(() => {});
        };
        for (const calendarUrl of calendarUrls) {
            if (seen.size >= maxEvents) break;
            console.log(`\n========== Calendar ${calendarUrl} ==========`);
            // A listed URL can be a calendar (event grid) or a single event page (a direct event link).
            let singleEvent = false;
            try {
                await page.goto(calendarUrl, { waitUntil: "networkidle", timeout: 60000 });
                await waitOutCloudflareChallenge(page, config);
                // Race the calendar grid against an event-page marker, so a direct event link is spotted at once
                // instead of waiting out the grid timeout.
                const asCalendar = page.waitForSelector(EVENT_LINK_SELECTOR, { timeout: 20000 }).then(() => "calendar").catch(() => null);
                const asEvent = page.waitForSelector(EVENT_PAGE_SELECTOR, { timeout: 20000 }).then(() => "event").catch(() => null);
                const kind = await Promise.race([asCalendar, asEvent]) ?? (await asCalendar) ?? (await asEvent);
                singleEvent = kind === "event";
                if (!kind) throw new Error("no event grid or event page found");
            } catch (error: any) {
                if (error instanceof CloudflareChallengeError || closedByUser || isBrowserClosedError(error)) throw error;
                // Neither a grid nor a visible button (e.g. already registered): still try it as one event if it's a Luma link.
                if (!isLumaLink(calendarUrl)) {
                    console.error(`\x1b[31mCould not load ${calendarUrl} (or it has no events listed), skipping it: ${error.message.split("\n")[0]}\x1b[0m`);
                    continue;
                }
                singleEvent = true;
            }
            if (singleEvent) {
                if (!seen.has(eventKey(calendarUrl)) && !skipped.has(eventKey(calendarUrl))) {
                    seen.add(eventKey(calendarUrl));
                    console.log(`(Not a calendar — treating ${calendarUrl} as a single event.)`);
                    if (dryRun) console.log(`  - ${calendarUrl}`);
                    else await registerOneEvent(calendarUrl);
                }
                continue;
            }

            // Apply to the events on screen, then scroll a bit to show more, until the bottom stays put.
            // Each event opens in its own tab, so the calendar keeps its scroll position.
            for (let stableAtBottom = 0; stableAtBottom < 3 && seen.size < maxEvents; ) {
                for (const link of await visibleEventLinks(page)) {
                    if (seen.has(eventKey(link)) || skipped.has(eventKey(link)) || seen.size >= maxEvents) continue;
                    stopIfClosed();
                    // Events hosted outside Luma (their own site) can't be registered for here
                    if (!isLumaLink(link)) {
                        skipped.add(eventKey(link));
                        console.log(`\n--- Skipping external event: ${link} ---`);
                        continue;
                    }
                    seen.add(eventKey(link));
                    if (dryRun) {
                        console.log(`  - ${link}`);
                        continue;
                    }
                    await registerOneEvent(link);
                }
                if (seen.size >= maxEvents) {
                    console.log(`MAX_EVENTS=${maxEvents} reached. Stopping.`);
                    break;
                }
                if (await isAtBottom(page)) {
                    // Give lazy loading time to append more events before deciding we're done
                    await page.waitForTimeout(randomBetween(1500, 2500));
                    stableAtBottom = (await isAtBottom(page)) ? stableAtBottom + 1 : 0;
                } else {
                    stableAtBottom = 0;
                }
                await scrollABit(page);
                await waitOutCloudflareChallenge(page, config);
            }
        }
        console.log(`Went through ${seen.size} events.`);
    } catch (error) {
        if (!closedByUser && !(error instanceof BrowserClosedError) && isBrowserClosedError(error)) {
            // Nothing reported the browser or the calendar tab closing: show what actually failed
            console.warn("  Stopped by a 'closed' error:", (error as Error).message.split("\n").slice(0, 6).join(" | "));
            console.warn("  at", (error as Error).stack?.split("\n").slice(1, 6).join(" | "));
        }
        if (closedByUser || error instanceof BrowserClosedError || isBrowserClosedError(error)) throw new BrowserClosedError();
        throw error;
    } finally {
        shuttingDown = true;
        await browser.close();
    }
    return result;
}
