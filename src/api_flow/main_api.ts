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
    const paginationLimit = 20; // Use 20 as requested
    const maxPages = 50; // Safety limit to prevent infinite loops
    let pageCount = 0;
    const seenCursors = new Set<string>(); // Track cursors to detect loops
    const seenEventIds = new Set<string>(); // Track event IDs to detect duplicate events

    console.log(`Fetching all event entries from Luma calendar API (ID: ${calendarApiId})...`);

    try {
        do {
            pageCount++;
            
            // Safety check: maximum pages
            if (pageCount > maxPages) {
                console.warn(`  Reached maximum page limit (${maxPages}). Stopping pagination to prevent infinite loop.`);
                break;
            }

            const params: Record<string, string | number> = {
                calendar_api_id: calendarApiId,
                period: 'future',
                pagination_limit: paginationLimit,
            };
            if (cursor) {
                // Check for repeated cursor (infinite loop detection)
                if (seenCursors.has(cursor)) {
                    console.warn(`  Detected repeated cursor: ${cursor}. This indicates an API bug. Stopping pagination.`);
                    break;
                }
                seenCursors.add(cursor);
                params.pagination_cursor = cursor; // Use correct parameter name
            }

            const apiUrl = 'https://api.luma.com/calendar/get-items';
            console.log(`  Fetching page ${pageCount}: ${apiUrl} with params: ${JSON.stringify(params)}`);
            
            const headers: Record<string, string> = {
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8',
                'Accept-Encoding': 'gzip, deflate, br, zstd',
                'Referer': 'https://luma.com/ethcc',
                'Origin': 'https://luma.com',
                'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
                'Sec-Ch-Ua-Mobile': '?0',
                'Sec-Ch-Ua-Platform': '"macOS"',
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Site': 'same-origin',
            };
            if (cookieString) {
                headers["cookie"] = cookieString;
            }

            // Add random delay between 1-3 seconds to appear more human
            const delay = Math.floor(Math.random() * 2000) + 1000;
            console.log(`  Adding human-like delay: ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));

            const response = await axios.get<LumaCalendarApiResponse>(apiUrl, { params, headers });
            
            if (response.data && response.data.entries) {
                // Check for duplicate events (another sign of API bug)
                const newEvents = response.data.entries.filter(entry => !seenEventIds.has(entry.event.api_id));
                const duplicateCount = response.data.entries.length - newEvents.length;
                
                if (duplicateCount > 0) {
                    console.warn(`  Warning: ${duplicateCount} duplicate events detected in this page. API may be buggy.`);
                }
                
                if (newEvents.length === 0 && pageCount > 1) {
                    console.warn(`  All events in this page are duplicates. Stopping pagination.`);
                    break;
                }
                
                // Add new events to our collection and tracking
                allEntries = allEntries.concat(newEvents);
                newEvents.forEach(entry => seenEventIds.add(entry.event.api_id));
                
                cursor = response.data.has_more ? response.data.next_cursor : undefined;
                console.log(`  Fetched ${response.data.entries.length} entries (${newEvents.length} new, ${duplicateCount} duplicates). Total unique: ${allEntries.length}. Has more: ${response.data.has_more}`);
                
                // Print details of each NEW entry for debugging
                if (newEvents.length > 0) {
                    console.log('  New entry details:');
                    newEvents.forEach((entry, index) => {
                        console.log(`    [${index + 1}] Event: "${entry.event.name}" | API ID: ${entry.event.api_id} | URL: ${entry.event.url} | Status: ${entry.status || 'N/A'} | Role Approval: ${entry.role?.approval_status || 'N/A'}`);
                    });
                }
                
                // Print pagination info
                console.log(`  Pagination: has_more=${response.data.has_more}, next_cursor=${response.data.next_cursor || 'none'}`);
                
                // Additional safety check: if has_more is true but no next_cursor provided
                if (response.data.has_more && !cursor) {
                    console.warn("  API indicates has_more=true but no next_cursor provided. Stopping pagination.");
                    break;
                }
            } else {
                console.warn(
                    "  No entries found in API response or malformed response."
                );
                cursor = undefined; // Stop pagination
            }
        } while (cursor);

        console.log(`Finished fetching after ${pageCount} pages. Total ${allEntries.length} unique event entries found.`);
        return allEntries;
    } catch (error: any) {
        console.error(`Error fetching event entries from Luma API for calendar ${calendarApiId} (stopped at page ${pageCount}):`);
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
        return allEntries; // Return what we have so far instead of empty array
    }
}
// --- End New Helper Function ---

// --- New Helper Function to Extract Calendar API ID from Page ---
async function getCalendarApiId(
    calendarUrl: string,
    cookieString: string | null
): Promise<string | null> {
    console.log(`Attempting to extract calendar_api_id from: ${calendarUrl} via HTTP`);
    try {
        const headers: { [key: string]: string } = {
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
            "Accept-Language": "en-US,en;q=0.9,fr;q=0.8",
            "User-Agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        };
        if (cookieString) {
            headers["cookie"] = cookieString;
        }

        const response = await axios.get<string>(calendarUrl, { headers });
        const pageContent = response.data;
        console.log(
            `  Successfully fetched page content (length: ${pageContent.length}).`
        );

        // 1. Try to get it from the apple-itunes-app meta tag (using regex)
        console.log("  Looking for apple-itunes-app meta tag...");
        const metaTagRegex =
            /<meta[^>]*name="apple-itunes-app"[^>]*content="([^"]*)"/;
        const metaMatch = pageContent.match(metaTagRegex);
        if (metaMatch && metaMatch[1]) {
            const content = metaMatch[1];
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
        console.log(
            "  apple-itunes-app meta tag not found or ID not in expected format."
        );

        // 2. Try __NEXT_DATA__ as a fallback
        console.log("  Looking for __NEXT_DATA__ as fallback...");
        const nextDataRegex =
            /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/;
        const nextDataMatch = pageContent.match(nextDataRegex);
        if (nextDataMatch && nextDataMatch[1]) {
            try {
                const jsonData = JSON.parse(nextDataMatch[1]);
                const calId =
                    jsonData.props?.pageProps?.calendar?.api_id ||
                    jsonData.props?.pageProps?.calendar_api_id ||
                    jsonData.props?.pageProps?.bootstrapApiResponse?.calendar
                        ?.api_id ||
                    jsonData.props?.pageProps?.bootstrapData
                        ?.calendar_api_id;

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
            } catch (e) {
                console.warn(
                    "  Failed to parse __NEXT_DATA__ JSON for calendar_api_id.",
                    e
                );
            }
        } else {
            console.log("  __NEXT_DATA__ script tag not found.");
        }

        // Fallback: Try to find it in the HTML content if not in __NEXT_DATA__
        console.log(
            "  Attempting fallback regex search for calendar_api_id in HTML content..."
        );
        const regex = /"calendar_api_id"\s*:\s*"(cal-[a-zA-Z0-9]+)"/;
        const htmlMatch = pageContent.match(regex);
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
            `  Error fetching or processing calendar page ${calendarUrl} for API ID:`,
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

        // We have the cookies, we can close the browser now.
        console.log("Closing browser as cookies are extracted...");
        await context.close();
        console.log("Browser closed.");

        // Get Calendar API ID from the URL using HTTP request with cookies
        const calendarApiId = await getCalendarApiId(
            eventCalendarUrl,
            cookieString
        );

        if (!calendarApiId) {
            console.error(
                `Failed to retrieve calendar_api_id from ${eventCalendarUrl}. Exiting.`
            );
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
            return;
        }
        console.log(
            `Found ${allEventEntries.length} total event entries from calendar API.`
        );

        for (const entry of allEventEntries) {
            const eventSlug = entry.event.url;
            const eventUrl = `https://luma.com/${eventSlug}`;
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
            
            // Add random delay between processing events (2-5 seconds)
            const eventDelay = Math.floor(Math.random() * 3000) + 2000;
            console.log(`  Adding delay between events: ${eventDelay}ms`);
            await new Promise(resolve => setTimeout(resolve, eventDelay));
            
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
        // Browser is already closed - no cleanup needed
        console.log("API flow completed.");
    }
}

mainApiFlow();
