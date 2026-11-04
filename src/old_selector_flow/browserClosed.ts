// Thrown when the user closes the browser (or a tab the bot is using): the whole run stops,
// instead of the bot opening a new window for the next event or account.
export class BrowserClosedError extends Error {
    constructor() {
        super("The browser was closed. Stopping the run.");
        this.name = "BrowserClosedError";
    }
}

export function isBrowserClosedError(error: unknown): boolean {
    return (
        error instanceof BrowserClosedError ||
        (error instanceof Error && /Target page, context or browser has been closed|Browser has been closed|Target closed/i.test(error.message))
    );
}
