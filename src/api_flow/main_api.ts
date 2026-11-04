import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import { Page, BrowserContext } from "playwright";
import { readConfig, readProfile } from "./config";
import * as fs from "fs/promises";
import dotenv from "dotenv";
import path from "path";
import { printRunSummary, runRegistrationForAccount } from "./lumaRunner";
import { getBrowserConfig } from "./browserConfig";


// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, "../../.env") }); // Adjusted path for .env

// --- Helper Function for Scrolling (Copied from main.ts) ---
async function autoScroll(page: Page): Promise<void> {
    console.log("  Starting auto-scroll...");
    await page.evaluate(async () => {
        await new Promise<void>((resolve) => {
            let lastHeight = document.body.scrollHeight;
            const scrollDelay = 2000;
            let consecutiveStableScrolls = 0;
            const requiredStableScrolls = 3;
            let totalScrolls = 0;
            const maxScrolls = 50;

            console.log(`  Initial scroll height: ${lastHeight}px`);

            const scrollInterval = setInterval(() => {
                totalScrolls++;
                console.log(`  Scrolling attempt #${totalScrolls}...`);
                window.scrollTo(0, document.body.scrollHeight);
                const newHeight = document.body.scrollHeight;

                if (newHeight === lastHeight) {
                    consecutiveStableScrolls++;
                    console.log(
                        `  Scroll height stable (${newHeight}px), check ${consecutiveStableScrolls}/${requiredStableScrolls}`
                    );
                } else {
                    lastHeight = newHeight;
                    consecutiveStableScrolls = 0;
                    console.log(`  Scroll height changed to ${newHeight}px`);
                }

                if (
                    consecutiveStableScrolls >= requiredStableScrolls ||
                    totalScrolls >= maxScrolls
                ) {
                    clearInterval(scrollInterval);
                    if (totalScrolls >= maxScrolls) {
                        console.warn(
                            "  Auto-scroll hit max attempts. Stopping."
                        );
                    } else {
                        console.log(
                            "  Scroll height stable. Auto-scrolling finished."
                        );
                    }
                    resolve();
                }
            }, scrollDelay);
        });
    });
}
// --- End Helper Function ---

// --- Main API Flow Function ---
async function mainApiFlow() {
    const stealthPlugin = stealth();
    chromium.use(stealthPlugin);

    const config = await readConfig();
    const browserConfig = getBrowserConfig(config["BROWSER"]);

    console.log(
        `Launching ${config["BROWSER"]} (${browserConfig.executablePath}) with profile (${browserConfig.userDataDir}) using stealth...`
    );

    const context: BrowserContext = await chromium.launchPersistentContext(
        browserConfig.userDataDir,
        {
            headless: false,
            executablePath: browserConfig.executablePath,
            args: ["--disable-blink-features=AutomationControlled"],
        }
    );

    console.log("Persistent context launched. Getting initial page...");
    const page = context.pages()[0];
    if (!page) {
        console.error(
            "Failed to get initial page from persistent context. Exiting."
        );
        await context.close();
        return;
    }
    console.log("Initial page obtained.");

    try {
        const loginUrl = "https://luma.com/signin";
        console.log(`Navigating to login page: ${loginUrl}...`);
        await page.goto(loginUrl, { waitUntil: "networkidle", timeout: 60000 });
        console.log(
            `Successfully navigated to ${loginUrl}. Please log in if prompted.`
        );

        console.log(
            "Waiting for redirection to https://luma.com/home after login..."
        );
        const homeUrl = "https://luma.com/home";
        const loginCheckTimeout = 180000;
        const checkInterval = 2000;
        let currentTime = 0;
        let loggedIn = false;

        while (currentTime < loginCheckTimeout) {
            if (page.url() === homeUrl) {
                console.log("Redirected to home page. Login successful.");
                loggedIn = true;
                break;
            }
            await page.waitForTimeout(checkInterval);
            currentTime += checkInterval;
            if (currentTime % 10000 === 0) {
                console.log(
                    `Still waiting for login, current URL: ${page.url()} (${
                        currentTime / 1000
                    }s passed)`
                );
            }
        }

        if (!loggedIn) {
            console.warn(
                `Timed out waiting for login redirection to ${homeUrl}. Proceeding anyway...`
            );
        }

        const profile = await readProfile();

        // Extract cookies after login
        let cookieString: string | null = null;
        if (loggedIn) {
            try {
                const cookies = await context.cookies();
                cookieString = cookies
                    .map((c) => `${c.name}=${c.value}`)
                    .join("; ");
                console.log("Successfully extracted cookies.");
            } catch (e) {
                console.warn("Failed to extract cookies after login:", e);
            }
        }

        // We have the cookies, we can close the browser now.
        console.log("Closing browser as cookies are extracted...");
        await context.close();
        console.log("Browser closed.");

        const result = await runRegistrationForAccount(cookieString, profile, config);
        console.log("\n--- Finished processing all events via API flow ---");
        printRunSummary(result);

        await new Promise((resolve) => setTimeout(resolve, 10000));
    } catch (error) {
        console.error(
            "\x1b[31mAn error occurred in mainApiFlow execution:\x1b[0m",
            error
        );
    } finally {
        // Browser is already closed - no cleanup needed
        console.log("API flow completed.");
    }
}

mainApiFlow();
