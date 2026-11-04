// Opens one Chrome window per account, each with its own profile, so you can log into several
// Luma accounts at once without logging out of any of them. Once logged in, the session cookie is
// saved to config.txt as COOKIES_ACCOUNT_<ID>.
//
// Chrome is launched as a plain process (no Playwright), because Cloudflare's captcha fails in
// automated browsers. The script only talks to Chrome's browser-level DevTools endpoint to read
// cookies, and never attaches to the page you log in on.
//
// Usage: npx ts-node src/cli/getCookies.ts [id...]   (default ids: one two)
import { spawn } from "child_process";
import * as fs from "fs/promises";
import path from "path";
import { getBrowserConfig } from "../api_flow/browserConfig";

const CONFIG_FILE = path.resolve(__dirname, "../../config.txt");
const PROFILES_ROOT = path.resolve(__dirname, "../../chrome_profiles");
const FIRST_DEBUG_PORT = 9331;
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const KEPT_COOKIES = ["luma.auth-session-key", "luma.did"];

interface CdpCookie {
    name: string;
    value: string;
    domain: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function saveToConfig(key: string, value: string): Promise<void> {
    let content = "";
    try {
        content = await fs.readFile(CONFIG_FILE, "utf-8");
    } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
    }
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    content = pattern.test(content)
        ? content.replace(pattern, line)
        : `${content.replace(/\n*$/, "")}\n${line}\n`;
    await fs.writeFile(CONFIG_FILE, content, "utf-8");
}

// Sends one command to the browser-level DevTools target and returns its result.
export async function browserCommand(port: number, method: string, params: object = {}): Promise<any> {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.close();
            reject(new Error(`${method} timed out`));
        }, 10000);
        socket.onopen = () => socket.send(JSON.stringify({ id: 1, method, params }));
        socket.onerror = () => {
            clearTimeout(timer);
            reject(new Error(`DevTools connection failed on port ${port}`));
        };
        socket.onmessage = (event) => {
            const message = JSON.parse(String(event.data));
            if (message.id !== 1) return;
            clearTimeout(timer);
            socket.close();
            message.error ? reject(new Error(message.error.message)) : resolve(message.result);
        };
    });
}

// Opens a plain Chrome window with the account's profile on the Luma sign-in page and waits until the
// profile is logged in. With saveCookie, the session cookie is also written to config.txt.
export async function captureAccount(id: string, port: number, executablePath: string, saveCookie = true): Promise<boolean> {
    const configKey = `COOKIES_ACCOUNT_${id.toUpperCase()}`;
    const label = saveCookie ? configKey : `account "${id}"`;
    const labelTab = `data:text/html,<title>${label}</title><h1 style="font-family:sans-serif">Log into the Luma account for ${label} in the next tab</h1>`;
    const chrome = spawn(
        executablePath,
        [
            `--user-data-dir=${path.join(PROFILES_ROOT, id)}`,
            `--remote-debugging-port=${port}`,
            "--no-first-run",
            "--no-default-browser-check",
            labelTab,
            "https://luma.com/signin",
        ],
        { stdio: "ignore" }
    );
    let chromeExited = false;
    chrome.on("exit", () => (chromeExited = true));
    console.log(`[${id}] Chrome window open. Log into the Luma account for ${label} (closes by itself once logged in).`);

    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (Date.now() < deadline && !chromeExited) {
        await sleep(3000);
        try {
            const { cookies } = (await browserCommand(port, "Storage.getCookies")) as { cookies: CdpCookie[] };
            const lumaCookies = cookies.filter((c) => c.domain.endsWith("luma.com"));
            if (lumaCookies.some((c) => c.name === "luma.auth-session-key")) {
                if (saveCookie) {
                    const value = lumaCookies
                        .filter((c) => KEPT_COOKIES.includes(c.name))
                        .map((c) => `${c.name}=${c.value}`)
                        .join("; ");
                    await saveToConfig(configKey, value);
                    console.log(`[${id}] Logged in. Saved ${configKey} to config.txt.`);
                } else {
                    console.log(`[${id}] Logged in.`);
                }
                // Closing the window keeps the session valid; only logging out would end it.
                await browserCommand(port, "Browser.close").catch(() => chrome.kill());
                return true;
            }
        } catch {
            // Chrome still starting up; try again
        }
    }
    console.error(`[${id}] ${chromeExited ? "Chrome was closed" : "Timed out"} before login completed.`);
    if (!chromeExited) chrome.kill();
    return false;
}

async function main(): Promise<void> {
    const ids = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["one", "two"];
    const { executablePath } = getBrowserConfig("chrome");
    const results = await Promise.all(
        ids.map((id, index) => captureAccount(id.toLowerCase(), FIRST_DEBUG_PORT + index, executablePath))
    );
    process.exit(results.every(Boolean) ? 0 : 1);
}

if (require.main === module) {
    main();
}
