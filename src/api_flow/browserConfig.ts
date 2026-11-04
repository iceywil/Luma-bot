import { spawnSync } from "child_process";
import { chromium } from "playwright-extra";
import path from "path";
import * as fs from "fs";

interface BrowserConfig {
    executablePath: string;
    userDataDir: string;
}

export function getBrowserConfig(browserType: string): BrowserConfig {
    const userDataDir = path.resolve(__dirname, "../playwright_chrome_profile");

    const paths: Record<string, Record<string, string>> = {
        darwin: { // macOS
            chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            brave: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            arc: "/Applications/Arc.app/Contents/MacOS/Arc",
        },
        linux: {
            // Debian's Chromium where Google Chrome isn't available (arm64 Docker image)
            chrome: fs.existsSync("/usr/bin/google-chrome") || !fs.existsSync("/usr/bin/chromium") ? "/usr/bin/google-chrome" : "/usr/bin/chromium",
            brave: "/usr/bin/brave-browser",
            // Arc is not available on Linux, so we can leave it out or handle it
        },
        // You can add more platforms like 'win32' for Windows
    };

    const platform = process.platform as keyof typeof paths;
    const platformPaths = paths[platform];

    if (!platformPaths) {
        throw new Error(`Unsupported platform: ${platform}`);
    }

    const browserKey = browserType.toLowerCase();
    let executablePath = platformPaths[browserKey];

    // Fallback to Chrome if the selected browser is not available on the current OS
    if (!executablePath) {
        console.warn(
            `Browser ${browserType} not found on ${platform}, falling back to Chrome.`
        );
        executablePath = platformPaths.chrome;
    }
    
    if (!executablePath) {
        throw new Error(`Chrome browser is not configured for platform: ${platform}`);
    }

    return {
        executablePath,
        userDataDir,
    };
}

// Extra flags for starting the real Chrome as a plain process (selector flow and leak test).
// - Headless: headless Chrome says "HeadlessChrome" in its user agent and has an 800x600 screen with no
//   menu bar, so it gets the user agent the same Chrome sends with a window (reduced form:
//   Chrome/<major>.0.0.0) and a usual screen for the platform (sizes in device pixels).
// - In Docker (CHROME_IN_CONTAINER=true): Chrome's sandbox can't start there, /dev/shm is tiny, and with
//   no GPU WebGL is turned off unless software rendering is allowed (no WebGL at all stands out to bot checks).
export function chromeLaunchArgs(executablePath: string, headless: boolean): string[] {
    const args: string[] = [];
    if (process.env.CHROME_IN_CONTAINER === "true") {
        args.push("--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader");
    }
    if (!headless) return args;
    const version = spawnSync(executablePath, ["--version"], { encoding: "utf-8" }).stdout || "";
    const major = version.match(/(\d+)\.\d+\.\d+\.\d+/)?.[1];
    const platform =
        process.platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7" :
        process.platform === "win32" ? "Windows NT 10.0; Win64; x64" :
        "X11; Linux x86_64";
    args.push("--headless=new");
    if (major) {
        args.push(`--user-agent=Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`);
    }
    if (process.platform === "darwin") {
        // 1440x900 Retina, the top 25px being the menu bar
        args.push("--screen-info={2880x1800 workAreaTop=50 devicePixelRatio=2 colorDepth=30}", "--window-size=1366,820");
    } else {
        // 1920x1080 with a 32px top bar (GNOME), Windows and Linux alike
        args.push("--screen-info={1920x1080 workAreaTop=32}", "--window-size=1600,980");
    }
    return args;
}
