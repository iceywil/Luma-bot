import { Page } from "playwright";
import { humanClickAt } from "./domUtils";

// Thrown when a Cloudflare challenge (captcha / "Just a moment...") can't be solved: the browser is
// headless, or nobody solved it in time. It stops the whole run, since the challenge is tied to the IP
// and continuing would only hit it again and flag the accounts.
export class CloudflareChallengeError extends Error {
    constructor(url: string, reason: string = "") {
        super(`Cloudflare challenge on ${url}${reason ? ` (${reason})` : ""}. Stopping the run.`);
        this.name = "CloudflareChallengeError";
    }
}

const CHALLENGE_SELECTORS = ["#challenge-form", "#challenge-running", "#cf-challenge-running", ".cf-turnstile"];
const CHALLENGE_TITLES = [/just a moment/i, /verify you are human/i, /checking your browser/i, /attention required/i];
const DEFAULT_CAPTCHA_WAIT_SECONDS = 300;

// True while a challenge is on screen: Cloudflare's full-page challenge, or Luma's "Verifying Your
// Browser" popup that wraps Turnstile on submit.
export async function isCloudflareChallenge(page: Page): Promise<boolean> {
    try {
        const title = await page.title();
        if (CHALLENGE_TITLES.some((re) => re.test(title))) return true;
        if (await page.getByText(/verifying your browser|verification failed/i).first().isVisible().catch(() => false)) {
            return true;
        }
        for (const selector of CHALLENGE_SELECTORS) {
            if (await page.locator(selector).first().isVisible().catch(() => false)) return true;
        }
        const bodyText = (await page.locator("body").innerText({ timeout: 2000 })).slice(0, 2000);
        return /verify you are human|needs to review the security of your connection/i.test(bodyText);
    } catch {
        return false;
    }
}

const TURNSTILE_FRAME_URL = /challenges\.cloudflare\.com/;
const MAX_CHECKBOX_CLICKS = 2;
const HEADLESS_CAPTCHA_WAIT_SECONDS = 30;
const randomIn = (min: number, max: number) => min + Math.random() * (max - min);

// Clicks the checkbox in Turnstile's iframe if it is showing. Its spot is read from inside the iframe
// (Patchright reaches into its closed shadow root); with `guess`, when it can't be found there, the usual
// spot is used: about 30px from the iframe's left edge, centered vertically. True if it clicked.
async function clickTurnstileCheckbox(page: Page, guess: boolean): Promise<boolean> {
    const frame = page.frames().find((f) => TURNSTILE_FRAME_URL.test(f.url()));
    if (!frame) return false;
    const frameBox = await (await frame.frameElement().catch(() => null))?.boundingBox();
    // Invisible mode, or not rendered yet
    if (!frameBox || frameBox.width < 30 || frameBox.height < 30) return false;
    const checkbox = frame.locator('input[type="checkbox"]').first();
    const box = (await checkbox.isVisible().catch(() => false)) ? await checkbox.boundingBox().catch(() => null) : null;
    if (box) {
        await humanClickAt(page, { x: box.x + box.width * randomIn(0.3, 0.7), y: box.y + box.height * randomIn(0.3, 0.7) });
        return true;
    }
    if (!guess) return false;
    await humanClickAt(page, { x: frameBox.x + 30 + randomIn(-4, 4), y: frameBox.y + frameBox.height / 2 + randomIn(-4, 4) });
    return true;
}

// If a challenge is showing, the bot clicks Turnstile's checkbox (up to twice; AUTO_CAPTCHA=false leaves
// it to you). If that doesn't clear it: in a visible browser (HEADLESS=false), wait for the user to solve
// it, up to CAPTCHA_WAIT_SECONDS (default 300); headless, or if nobody solves it, stop the run.
export async function waitOutCloudflareChallenge(page: Page, config: Record<string, string>): Promise<void> {
    if (!(await isCloudflareChallenge(page))) return;
    const headless = config["HEADLESS"] !== "false";
    const autoClick = config["AUTO_CAPTCHA"] !== "false";
    if (headless && !autoClick) {
        throw new CloudflareChallengeError(page.url(), "headless, nobody can solve it");
    }
    const waitSeconds = headless
        ? HEADLESS_CAPTCHA_WAIT_SECONDS
        : parseInt(config["CAPTCHA_WAIT_SECONDS"] || "", 10) || DEFAULT_CAPTCHA_WAIT_SECONDS;
    const askUser = () => {
        // \x07 rings the terminal bell so you notice
        console.warn(`\x07\x1b[33mCloudflare captcha on ${page.url()}. Solve it in the Chrome window (waiting up to ${waitSeconds}s)...\x1b[0m`);
        page.bringToFront().catch(() => {});
    };
    if (autoClick) console.log(`  Cloudflare captcha on ${page.url()}. Clicking the Turnstile checkbox...`);
    else askUser();

    const started = Date.now();
    // Turnstile often passes on its own after a few seconds; a click comes after a human-like delay
    let nextClickAt = started + randomIn(2000, 4000);
    let clicks = 0;
    let askedUser = !autoClick;
    while (Date.now() < started + waitSeconds * 1000) {
        await page.waitForTimeout(1000);
        if (!(await isCloudflareChallenge(page))) {
            console.log(clicks > 0 ? `  Captcha passed after ${clicks} checkbox click(s), continuing.` : "  Captcha solved, continuing.");
            return;
        }
        if (autoClick && clicks < MAX_CHECKBOX_CLICKS && Date.now() >= nextClickAt) {
            // Guess the checkbox spot only once Turnstile had time to render it
            if (await clickTurnstileCheckbox(page, Date.now() - started > 8000).catch(() => false)) {
                clicks++;
                console.log(`  Clicked the Turnstile checkbox (${clicks}/${MAX_CHECKBOX_CLICKS}).`);
                nextClickAt = Date.now() + randomIn(8000, 12000);
            }
        } else if (autoClick && clicks >= MAX_CHECKBOX_CLICKS && !askedUser && Date.now() >= nextClickAt) {
            if (headless) break;
            askedUser = true;
            askUser();
        }
    }
    throw new CloudflareChallengeError(page.url(), headless ? "the checkbox click didn't pass it (headless)" : `not solved within ${waitSeconds}s`);
}
