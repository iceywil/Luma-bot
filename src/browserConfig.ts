import { chromium } from "playwright-extra";
import path from "path";

interface BrowserConfig {
    executablePath: string;
    userDataDir: string;
}

export function getBrowserConfig(browserType: string): BrowserConfig {
    const userDataDir = path.resolve(__dirname, "../playwright_chrome_profile");

    const browserConfigs: Record<string, BrowserConfig> = {
        chrome: {
            executablePath:
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            userDataDir,
        },
        brave: {
            executablePath:
                "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            userDataDir,
        },
        arc: {
            executablePath: "/Applications/Arc.app/Contents/MacOS/Arc",
            userDataDir,
        },
    };

    const config = browserConfigs[browserType.toLowerCase()];
    if (!config) {
        console.warn(
            `Browser ${browserType} not found, falling back to Chrome`
        );
        return browserConfigs.chrome;
    }

    return config;
}
