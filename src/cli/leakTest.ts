// Checks whether a CDP client attached to Chrome is visible to the page, the way Cloudflare's Turnstile
// would see it during the submit. Serves leakTest/page.html, which runs the checks in the page and in a
// cross-site iframe (like Turnstile's) and reports them back here over HTTP, so reading the results
// never attaches anything.
//
// Chrome is started as a plain process like selectorRunner.ts does, then, depending on the mode:
// - none: nothing attaches (baseline, everything should be clean)
// - playwright: Playwright connectOverCDP, the current bot setup
// - patchright: the same with Patchright (npm i -D patchright first)
// One tab is open before attaching, a second one is opened after it, like the bot's event tabs.
//
// Usage: npx ts-node src/cli/leakTest.ts [none|playwright|patchright]
//   HEADLESS=true, LEAK_TEST_SECONDS=20, KEEP_OPEN=true (leave Chrome open to look at the page)
import { spawn } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import path from "path";
import { getBrowserConfig, chromeLaunchArgs } from "../api_flow/browserConfig";
import { browserCommand } from "./getCookies";

const SERVER_PORT = 9480;
const DEBUG_PORT = 9481;
const PAGE_FILE = path.join(__dirname, "leakTest", "page.html");
const MODES = ["none", "playwright", "patchright"];

interface Report {
    tab: string;
    role: "top" | "iframe";
    results: Record<string, unknown>;
    ever: Record<string, boolean>;
    hasFocus: boolean;
    hidden: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

// reports: latest report per frame. costs: every console cost a frame reported, oldest first.
function startServer(reports: Map<string, Report>, costs: Map<string, number[]>): Promise<http.Server> {
    const html = fs.readFileSync(PAGE_FILE, "utf-8");
    const server = http.createServer((req, res) => {
        if (req.method === "POST" && req.url === "/report") {
            let body = "";
            req.on("data", (chunk) => (body += chunk));
            req.on("end", () => {
                try {
                    const report: Report = JSON.parse(body);
                    const name = `${report.tab} / ${report.role}`;
                    reports.set(name, report);
                    costs.set(name, [...(costs.get(name) ?? []), Number(report.results.consoleCost)]);
                } catch {}
                res.end();
            });
            return;
        }
        if (req.url === "/favicon.ico") {
            res.writeHead(404).end();
            return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
    });
    // No host: listens on both localhost and 127.0.0.1, the two sites the page uses
    return new Promise((resolve) => server.listen(SERVER_PORT, () => resolve(server)));
}

// Loads Playwright or Patchright only when asked, so Patchright stays optional
function loadChromium(mode: string): any {
    try {
        return require(mode).chromium;
    } catch {
        throw new Error(`${mode} is not installed. Run: npm i -D ${mode}`);
    }
}

async function main(): Promise<number> {
    const mode = (process.argv[2] || "playwright").toLowerCase();
    if (!MODES.includes(mode)) {
        console.error(`Unknown mode "${mode}". Use one of: ${MODES.join(", ")}`);
        return 2;
    }
    const headless = process.env.HEADLESS === "true";
    const seconds = parseInt(process.env.LEAK_TEST_SECONDS || "", 10) || 20;
    const chromiumImpl = mode === "none" ? null : loadChromium(mode);

    const reports = new Map<string, Report>();
    const costs = new Map<string, number[]>();
    const server = await startServer(reports, costs);
    const pageUrl = (tab: string) => `http://localhost:${SERVER_PORT}/?tab=${tab}`;

    // Fresh profile each run, so nothing from the accounts' profiles is touched
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "luma-leak-test-"));
    const executablePath = getBrowserConfig("chrome").executablePath;
    const chrome = spawn(
        executablePath,
        [
            `--user-data-dir=${profileDir}`,
            `--remote-debugging-port=${DEBUG_PORT}`,
            "--no-first-run",
            "--no-default-browser-check",
            ...chromeLaunchArgs(executablePath, headless),
            pageUrl("before-attach"),
        ],
        { stdio: "ignore" }
    );
    let exited = false;
    chrome.on("exit", () => (exited = true));
    for (let waited = 0; ; waited += 500) {
        if (exited) throw new Error("Chrome exited on startup.");
        if (waited > 30000) throw new Error("Chrome did not open its DevTools port within 30s.");
        if (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then((r) => r.ok, () => false)) break;
        await sleep(500);
    }
    console.log(`Mode: ${mode}${headless ? " (headless)" : ""}. Page loads unattached first...`);
    await sleep(6000);

    // Console cost of each frame while nothing is attached; the tab opened later uses its sibling's
    const baselineCost = new Map<string, number>();
    for (const [name, report] of reports) baselineCost.set(report.role, median(costs.get(name)!.slice(1)));

    let browser: any = null;
    if (chromiumImpl) {
        console.log(`Attaching ${mode} over CDP...`);
        browser = await chromiumImpl.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
        // What the bot does on an event tab: open it, read the DOM, click
        const page = await browser.contexts()[0].newPage();
        await page.goto(pageUrl("opened-after-attach"), { waitUntil: "load" });
        await page.locator("h1").textContent();
        await page.evaluate(() => document.title);
        await page.locator("h1").click();
    } else {
        // Plain HTTP endpoint, attaches to nothing
        await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${pageUrl("opened-after-attach")}`, { method: "PUT" });
    }

    console.log(`Collecting reports for ${seconds}s...`);
    await sleep(seconds * 1000);

    const keys = ["webdriver", "automationGlobals", "focusWhileHidden", "headlessUA", "headlessBrand", "headlessScreen", "noWindowChrome", "noPlugins"];
    const rows = [...reports.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, report]) => {
        const row: Record<string, string> = { frame: name };
        // 3x as slow as before attaching = a client has Runtime enabled (no client stays under ~2.5x, Playwright is 4-10x)
        const ratio = median(costs.get(name)!.slice(-5)) / (baselineCost.get(report.role) || NaN);
        row.runtimeEnabled = Number.isFinite(ratio) ? `${ratio >= 3 ? "LEAK" : "ok"} (x${ratio.toFixed(1)})` : "no baseline";
        for (const key of keys) {
            if (!(key in report.results)) continue;
            const value = report.results[key];
            row[key] = report.ever[key] ? (typeof value === "string" ? `LEAK: ${value}` : "LEAK") : "ok";
        }
        return row;
    });
    console.log(`\nResults for mode "${mode}" ("LEAK" = seen at least once):`);
    console.table(rows);
    const expected = 4; // 2 tabs x (page + iframe)
    if (reports.size < expected) {
        console.warn(`\x1b[33mOnly ${reports.size}/${expected} frames reported. Did a tab fail to load?\x1b[0m`);
    }
    const leaked = rows.some((row) => Object.entries(row).some(([key, value]) => key !== "frame" && value.startsWith("LEAK")));
    console.log(leaked ? "\x1b[31mDetectable.\x1b[0m" : "\x1b[32mNothing detected.\x1b[0m");

    if (process.env.KEEP_OPEN === "true") {
        console.log("KEEP_OPEN=true: Chrome stays open, press Ctrl+C to quit.");
        await new Promise(() => {});
    }
    // Disconnect first, so Chrome closes cleanly over its own endpoint
    await browser?.close().catch(() => {});
    await browserCommand(DEBUG_PORT, "Browser.close").catch(() => chrome.kill());
    for (let waited = 0; !exited && waited < 10000; waited += 250) await sleep(250);
    if (!exited) chrome.kill();
    server.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
    return leaked ? 1 : 0;
}

main().then(
    (code) => process.exit(code),
    (error) => {
        console.error(error);
        process.exit(1);
    }
);
