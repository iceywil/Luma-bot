import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import { Browser, Page, BrowserContext } from "playwright";
import { readConfig, readProfile } from "../config";
import * as fs from "fs/promises";
import dotenv from "dotenv";
import path from "path";
import axios from "axios";
import {
    fetchEventDetails,
    prepareRegistrationAnswers,
    submitRegistration,
    APIRegistrationQuestion,
    APITicketType,
    APIEventDetails,
    APIRegistrationAnswer,
} from "./api_helper";
import { getBrowserConfig } from "../browserConfig";

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

// --- New Helper Function to Fetch All Event Entries from Luma Calendar API ---
interface LumaCalendarEntryEvent {
    api_id: string;
    name: string;
    url: string; // This is the event slug
    // Add other event fields if needed from the provided JSON
}

interface LumaCalendarEntryTicketInfo {
    require_approval?: boolean;
    is_free?: boolean;
    // Add other relevant fields from ticket_info if needed
}

interface LumaCalendarEntryRole {
    approval_status?: string;
    // Add other role fields if needed, e.g., type
}

interface LumaCalendarEntry {
    api_id: string; // Calendar Event ID (calev-...)
    event: LumaCalendarEntryEvent;
    status?: string; // General status of the calendar entry (might be different from your role)
    ticket_info?: LumaCalendarEntryTicketInfo;
    role?: LumaCalendarEntryRole; // User-specific role and approval status for this calendar event
    // Add other entry fields if needed
}

interface LumaCalendarApiResponse {
    entries: LumaCalendarEntry[];
    has_more: boolean;
    next_cursor?: string;
}

async function fetchAllEventEntriesFromCalendarApi(
    calendarApiId: string,
    cookieString: string | null // For authenticated requests to get correct status
): Promise<LumaCalendarEntry[]> {
    let allEntries: LumaCalendarEntry[] = [];
    let cursor: string | undefined = undefined;
    const paginationLimit = 50; // Luma's default seems to be 20, can be increased

    console.log(
        `Fetching all event entries from Luma calendar API (ID: ${calendarApiId})...`
    );

    try {
        do {
            const params: Record<string, string | number> = {
                calendar_api_id: calendarApiId,
                period: "future", // Or 'all', 'past'
                pagination_limit: paginationLimit,
            };
            if (cursor) {
                params.cursor = cursor;
            }

            const apiUrl = "https://api.lu.ma/calendar/get-items";
            console.log(
                `  Fetching page: ${apiUrl} with params: ${JSON.stringify(
                    params
                )}`
            );

            const headers: Record<string, string> = {
                Accept: "application/json",
            };
            if (cookieString) {
                headers["cookie"] = cookieString;
            }

            const response = await axios.get<LumaCalendarApiResponse>(apiUrl, {
                params,
                headers,
            });

            if (response.data && response.data.entries) {
                allEntries = allEntries.concat(response.data.entries);
                cursor = response.data.has_more
                    ? response.data.next_cursor
                    : undefined;
                console.log(
                    `  Fetched ${
                        response.data.entries.length
                    } entries. Total: ${
                        allEntries.length
                    }. Has more: ${!!cursor}`
                );
            } else {
                console.warn(
                    "  No entries found in API response or malformed response."
                );
                cursor = undefined; // Stop pagination
            }
        } while (cursor);

        console.log(
            `Finished fetching. Total ${allEntries.length} event entries found.`
        );
        return allEntries;
    } catch (error: any) {
        console.error(
            `Error fetching event entries from Luma API for calendar ${calendarApiId}:`
        );
        if (error.response) {
            console.error("  Status:", error.response.status);
            console.error(
                "  Data:",
                JSON.stringify(error.response.data).substring(0, 300)
            );
        } else if (error.request) {
            console.error("  Request error:", error.request);
        } else {
            console.error("  Error message:", error.message);
        }
        return []; // Return empty array on error
    }
}
// --- End New Helper Function ---

// --- New Helper Function to Extract Calendar API ID from Page ---
async function getCalendarApiIdFromPage(
    page: Page,
    calendarUrl: string
): Promise<string | null> {
    console.log(`Attempting to extract calendar_api_id from: ${calendarUrl}`);
    try {
        await page.goto(calendarUrl, {
            waitUntil: "networkidle",
            timeout: 60000,
        });
        console.log(`  Navigated to ${calendarUrl}.`);

        // 1. Try to get it from the apple-itunes-app meta tag
        console.log("  Looking for apple-itunes-app meta tag...");
        const appleMetaTag = await page
            .locator('meta[name="apple-itunes-app"]')
            .first();
        if (await appleMetaTag.count()) {
            const content = await appleMetaTag.getAttribute("content");
            if (content) {
                const match = content.match(
                    /luma:\/\/calendar\/(cal-[a-zA-Z0-9]+)/
                );
                if (match && match[1]) {
                    console.log(
                        `  Extracted calendar_api_id from apple-itunes-app meta tag: ${match[1]}`
                    );
                    return match[1];
                }
            }
        }
        console.log(
            "  apple-itunes-app meta tag not found or ID not in expected format."
        );

        // 2. Try __NEXT_DATA__ as a fallback
        console.log("  Looking for __NEXT_DATA__ as fallback...");
        const nextDataElement = await page
            .locator('script#__NEXT_DATA__[type="application/json"]')
            .first();
        if (await nextDataElement.count()) {
            const nextDataJson = await nextDataElement.textContent();
            if (nextDataJson) {
                try {
                    const jsonData = JSON.parse(nextDataJson);
                    // Common paths for calendar_api_id - these are guesses and might need adjustment
                    const calId =
                        jsonData.props?.pageProps?.calendar?.api_id ||
                        jsonData.props?.pageProps?.calendar_api_id ||
                        jsonData.props?.pageProps?.bootstrapApiResponse
                            ?.calendar?.api_id ||
                        jsonData.props?.pageProps?.bootstrapData
                            ?.calendar_api_id; // Another common pattern

                    if (
                        calId &&
                        typeof calId === "string" &&
                        calId.startsWith("cal-")
                    ) {
                        console.log(
                            `  Extracted calendar_api_id from __NEXT_DATA__: ${calId}`
                        );
                        return calId;
                    }
                    console.log(
                        "  Could not find calendar_api_id in __NEXT_DATA__ at common paths."
                    );
                    // console.log('__NEXT_DATA__ content:', JSON.stringify(jsonData, null, 2).substring(0, 1000)); // For debugging
                } catch (e) {
                    console.warn(
                        "  Failed to parse __NEXT_DATA__ JSON for calendar_api_id.",
                        e
                    );
                }
            }
        } else {
            console.log("  __NEXT_DATA__ script tag not found.");
        }

        // Fallback: Try to find it in the HTML content if not in __NEXT_DATA__
        // This is less reliable and more prone to breakage
        console.log(
            "  Attempting fallback regex search for calendar_api_id in HTML content..."
        );
        const pageContent = await page.content();
        const regex = /"calendar_api_id"\s*:\s*"(cal-[a-zA-Z0-9]+)"/;
        const htmlMatch = pageContent.match(regex); // Renamed to avoid conflict with earlier 'match'
        if (htmlMatch && htmlMatch[1]) {
            console.log(
                `  Extracted calendar_api_id using general HTML fallback regex: ${htmlMatch[1]}`
            );
            return htmlMatch[1];
        }

        console.error(
            "  Could not extract calendar_api_id from page using any method."
        );
        return null;
    } catch (error) {
        console.error(
            `  Error navigating to or processing calendar page ${calendarUrl} for API ID:`,
            error
        );
        return null;
    }
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

    const processingFailures: string[] = [];
    const successfulRegistrations: string[] = [];

    try {
        const loginUrl = "https://lu.ma/signin";
        console.log(`Navigating to login page: ${loginUrl}...`);
        await page.goto(loginUrl, { waitUntil: "networkidle", timeout: 60000 });
        console.log(
            `Successfully navigated to ${loginUrl}. Please log in if prompted.`
        );

        console.log(
            "Waiting for redirection to https://lu.ma/home after login..."
        );
        const homeUrl = "https://lu.ma/home";
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

        const eventCalendarUrl = config["EVENT_CALENDAR_URL"]; // Reverted to EVENT_CALENDAR_URL
        if (!eventCalendarUrl) {
            throw new Error(
                "EVENT_CALENDAR_URL not found in config.txt. Please add it (e.g., EVENT_CALENDAR_URL=https://lu.ma/u/xxxx/events)."
            );
        }

        // Extract cookies after login
        let cookieString: string | null = null;
        if (loggedIn) {
            try {
                const cookies = await context.cookies();
                cookieString = cookies
                    .map((c) => `${c.name}=${c.value}`)
                    .join("; ");
                console.log("Successfully extracted cookies.");
                // console.log('Cookies:', cookieString); // Optional: for debugging
            } catch (e) {
                console.warn("Failed to extract cookies after login:", e);
            }
        }

        // Get Calendar API ID from the URL using Playwright page
        const calendarApiId = await getCalendarApiIdFromPage(
            page,
            eventCalendarUrl
        );

        if (!calendarApiId) {
            console.error(
                `Failed to retrieve calendar_api_id from ${eventCalendarUrl}. Exiting.`
            );
            if (!context.browser()?.browserType().name().includes("headless")) {
                await page.waitForTimeout(10000);
            }
            await context.close();
            return;
        }
        console.log(
            `Using Calendar API ID: ${calendarApiId} extracted from ${eventCalendarUrl}`
        );

        const allEventEntries = await fetchAllEventEntriesFromCalendarApi(
            calendarApiId,
            cookieString
        );

        if (allEventEntries.length === 0) {
            console.log("No event entries found from the API. Exiting.");
            if (!context.browser()?.browserType().name().includes("headless")) {
                await page.waitForTimeout(10000);
            }
            await context.close();
            return;
        }
        console.log(
            `Found ${allEventEntries.length} total event entries from calendar API.`
        );

        for (const entry of allEventEntries) {
            const eventSlug = entry.event.url;
            const eventUrl = `https://lu.ma/${eventSlug}`;
            const eventApiId = entry.event.api_id;
            const eventName = entry.event.name;

            console.log(
                `\n--- Processing Event via API: ${eventName} (${eventUrl}) ---`
            );
            console.log(
                `  Event API ID: ${eventApiId}, Top-level Status: ${
                    entry.status || "N/A"
                }, Your Role Approval: ${entry.role?.approval_status || "N/A"}`
            );

            // Check registration status based on the user's role approval_status for this specific calendar event entry
            const positiveRegistrationStatuses = [
                "approved",
                "pending_approval",
            ]; // Added 'pending_approval'
            if (
                entry.role?.approval_status &&
                positiveRegistrationStatuses.includes(
                    entry.role.approval_status.toLowerCase()
                )
            ) {
                console.log(
                    `  User has role approval status "${entry.role.approval_status}" for "${eventName}". Skipping.`
                );
                successfulRegistrations.push(
                    `${eventUrl} (Skipped, role approval: ${entry.role.approval_status})`
                );
                continue;
            }

            let success = false;
            try {
                const eventDetails = await fetchEventDetails(eventApiId);
                if (
                    !eventDetails ||
                    !eventDetails.registration_questions ||
                    !eventDetails.ticket_types
                ) {
                    console.error(
                        `  Could not fetch valid event details for ${eventApiId} from ${eventUrl}. Skipping.`
                    );
                    processingFailures.push(
                        `${eventUrl} (Failed to fetch details)`
                    );
                    continue;
                }
                console.log(`  Fetched details for: ${eventName}`);
                console.log(
                    `  Found ${eventDetails.registration_questions.length} registration questions.`
                );
                console.log(
                    `  Found ${eventDetails.ticket_types.length} ticket types.`
                );

                // Find a suitable FREE ticket that is not hidden, not disabled, not sold out, and not expired
                const suitableTicket = eventDetails.ticket_types.find(
                    (tt) =>
                        tt.type === "free" &&
                        !tt.is_hidden &&
                        !tt.is_disabled &&
                        !tt.is_sold_out &&
                        (!tt.valid_end_at ||
                            new Date(tt.valid_end_at) > new Date())
                );

                if (!suitableTicket) {
                    console.warn(
                        `  No suitable (type === 'free', not hidden, not disabled, not sold out, not expired) ticket found for ${eventName}. Skipping.`
                    );
                    processingFailures.push(
                        `${eventUrl} (No free ticket found)`
                    );
                    continue;
                }
                console.log(
                    `  Selected ticket: ${suitableTicket.name} (ID: ${suitableTicket.api_id}, Type: ${suitableTicket.type})`
                );

                const registrationAnswers = await prepareRegistrationAnswers(
                    eventDetails.registration_questions,
                    profile,
                    eventName,
                    config
                );

                if (
                    !registrationAnswers ||
                    (eventDetails.registration_questions.length > 0 &&
                        registrationAnswers.length === 0 &&
                        eventDetails.registration_questions.some(
                            (q) => q.required
                        ))
                ) {
                    console.error(
                        `  Failed to prepare all required registration answers for ${eventName}. Skipping.`
                    );
                    processingFailures.push(
                        `${eventUrl} (Answer preparation failed for required questions)`
                    );
                    continue;
                }
                if (
                    eventDetails.registration_questions.length > 0 &&
                    registrationAnswers.length !==
                        eventDetails.registration_questions.length
                ) {
                    console.warn(
                        `  Mismatch in prepared answers (${registrationAnswers.length}) vs questions (${eventDetails.registration_questions.length}) for ${eventName}. Proceeding cautiously.`
                    );
                }

                const payload = {
                    event_api_id: eventApiId,
                    name: `${profile["Name"]}`,
                    first_name:
                        profile["First Name"] ||
                        profile["Name"]?.split(" ")[0] ||
                        "",
                    last_name:
                        profile["Last Name"] ||
                        profile["Name"]?.split(" ").slice(1).join(" ") ||
                        "",
                    email: profile["Email"],
                    phone_number: profile["WhatsApp"] || profile["Phone"],
                    ticket_type_to_selection: {
                        [suitableTicket.api_id]: { count: 1, amount: 0 },
                    },
                    registration_answers: registrationAnswers,
                    for_waitlist: false,
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                    coupon_code: null,
                    currency: null,
                    eth_address_info: null,
                    event_invite_api_id: null,
                    expected_amount_cents: 0,
                    expected_amount_discount: 0,
                    expected_amount_tax: 0,
                    opened_from: null,
                    payment_currency: null,
                    payment_method: null,
                    solana_address: null,
                    solana_address_info: null,
                    token_gate_info: null,
                };

                console.log(`  Submitting registration for ${eventName}...`);
                const submissionResult = await submitRegistration(
                    payload,
                    cookieString,
                    eventUrl
                );

                if (submissionResult) {
                    console.log(
                        `  Registration submitted for ${eventName}. Response:`,
                        JSON.stringify(submissionResult).substring(0, 200) +
                            "..."
                    );
                    success = true;
                    successfulRegistrations.push(eventUrl);
                } else {
                    console.error(
                        `  Registration submission failed for ${eventName}.`
                    );
                    processingFailures.push(
                        `${eventUrl} (Submission API call failed)`
                    );
                }
            } catch (eventError) {
                console.error(
                    `  Error processing event ${eventName} (${eventUrl}) with API flow:`,
                    eventError
                );
                processingFailures.push(
                    `${eventUrl} (Runtime error in API flow for ${eventName})`
                );
            }
        }

        console.log("\n--- Finished processing all events via API flow ---");

        if (successfulRegistrations.length > 0) {
            console.log(
                `\n--- Successfully submitted API registration for ${successfulRegistrations.length} event(s): ---`
            );
            successfulRegistrations.forEach((url) => console.log(`  - ${url}`));
        }

        if (processingFailures.length > 0) {
            console.warn(
                `\n--- API Processing failed for ${processingFailures.length} event(s): ---`
            );
            processingFailures.forEach((url) => console.warn(`  - ${url}`));
        } else if (successfulRegistrations.length === 0) {
            console.log(
                "\nNo events were successfully registered via API, and no failures were explicitly recorded beyond initial skips."
            );
        }

        await new Promise((resolve) => setTimeout(resolve, 10000));
    } catch (error) {
        console.error(
            "\x1b[31mAn error occurred in mainApiFlow execution:\x1b[0m",
            error
        );
    } finally {
        console.log("Closing browser...");
        if (context && context.close) await context.close();
        console.log("Browser closed.");
    }
}

mainApiFlow();
