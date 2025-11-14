import { chromium } from "playwright-extra";
import path from "path";

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
            chrome: "/usr/bin/google-chrome",
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
