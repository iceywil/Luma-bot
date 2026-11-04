import axios from "axios";
import * as fs from "fs/promises";
import path from "path";
import {
    fetchEventDetails,
    prepareRegistrationAnswers,
    submitRegistration,
} from "./api_helper";

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
    platform?: string; // "external" for events hosted outside Luma (no event api_id, can't register)
    status?: string; // General status of the calendar entry (might be different from your role)
    ticket_info?: LumaCalendarEntryTicketInfo;
    role?: LumaCalendarEntryRole; // Legacy field, Luma now returns the user's status in guest_info
    guest_info?: LumaCalendarEntryRole | null; // User-specific approval status for this event (null if not registered)
    // Add other entry fields if needed
}

interface LumaCalendarApiResponse {
    entries: LumaCalendarEntry[];
    has_more: boolean;
    next_cursor?: string;
}

export async function fetchAllEventEntriesFromCalendarApi(
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
                const newEvents = response.data.entries.filter(entry => !seenEventIds.has(entry.event.api_id || entry.api_id));
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
                newEvents.forEach(entry => seenEventIds.add(entry.event.api_id || entry.api_id));
                
                cursor = response.data.has_more ? response.data.next_cursor : undefined;
                console.log(`  Fetched ${response.data.entries.length} entries (${newEvents.length} new, ${duplicateCount} duplicates). Total unique: ${allEntries.length}. Has more: ${response.data.has_more}`);
                
                // Print details of each NEW entry for debugging
                if (newEvents.length > 0) {
                    console.log('  New entry details:');
                    newEvents.forEach((entry, index) => {
                        console.log(`    [${index + 1}] Event: "${entry.event.name}" | API ID: ${entry.event.api_id} | URL: ${entry.event.url} | Status: ${entry.status || 'N/A'} | Your Approval: ${getApprovalStatus(entry) || 'N/A'}`);
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
export async function getCalendarApiId(
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


// --- Session / cookie helpers ---

// Only the auth cookies matter. Cloudflare cookies (cf_clearance, __cf_bm) are bound to the IP and
// user agent that obtained them, and the per-event "registered-with" cookies are irrelevant.
const LUMA_AUTH_COOKIES = ["luma.auth-session-key", "luma.did"];

// Accepts either a full "Cookie:" header copied from the browser, or just the session key value.
export function normalizeLumaCookie(raw: string): string | null {
    const value = raw.trim().replace(/^cookie:\s*/i, "");
    if (!value) return null;
    if (!value.includes("=")) {
        return `luma.auth-session-key=${value}`;
    }
    const kept = value
        .split(";")
        .map((part) => part.trim())
        .filter((part) => LUMA_AUTH_COOKIES.includes(part.split("=")[0]));
    return kept.some((part) => part.startsWith("luma.auth-session-key="))
        ? kept.join("; ")
        : null;
}

export async function isLumaSessionValid(cookieString: string): Promise<boolean> {
    try {
        const response = await axios.get("https://api.luma.com/home/get-events", {
            params: { period: "future", pagination_limit: 1 },
            headers: {
                Accept: "application/json",
                Origin: "https://luma.com",
                "User-Agent":
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
                cookie: cookieString,
            },
            validateStatus: () => true,
        });
        return response.status === 200;
    } catch (error: any) {
        console.error("  Session check failed:", error.message);
        return false;
    }
}

// --- Per-account registration run ---

export interface AccountRunResult {
    successfulRegistrations: string[];
    processingFailures: string[];
    // Luma rate-limited or blocked us; remaining events are left for the next run.
    stoppedEarly: boolean;
}

// Statuses meaning we already applied to the event (or were refused), so registering again is pointless.
const ALREADY_HANDLED_STATUSES = ["approved", "pending_approval", "waitlist", "declined"];

function getApprovalStatus(entry: LumaCalendarEntry): string | undefined {
    return (entry.guest_info?.approval_status || entry.role?.approval_status)?.toLowerCase();
}

const SUBMISSIONS_DIR = path.resolve(__dirname, "../../logs");
const PHONE_KEYS = ["Phone Number", "Phone", "WhatsApp", "Mobile"];

function profileValue(profile: Record<string, string>, keys: string[]): string | undefined {
    const value = keys.map((k) => profile[k]).find((v) => v && v.trim().toLowerCase() !== "n/a");
    return value?.trim();
}

// Appends one line per registration (or dry run) to logs/submissions.jsonl so answers can be reviewed.
async function logSubmission(record: Record<string, unknown>): Promise<void> {
    try {
        await fs.mkdir(SUBMISSIONS_DIR, { recursive: true });
        await fs.appendFile(path.join(SUBMISSIONS_DIR, "submissions.jsonl"), JSON.stringify(record) + "\n");
    } catch (error: any) {
        console.warn("  Could not write submission log:", error.message);
    }
}

export async function runRegistrationForAccount(
    cookieString: string | null,
    profile: Record<string, string>,
    config: Record<string, string>,
    accountId: string = "local"
): Promise<AccountRunResult> {
    const result: AccountRunResult = {
        successfulRegistrations: [],
        processingFailures: [],
        stoppedEarly: false,
    };
    const { successfulRegistrations, processingFailures } = result;

    const eventCalendarUrl = config["EVENT_CALENDAR_URL"];
    if (!eventCalendarUrl) {
        throw new Error(
            "EVENT_CALENDAR_URL not set. Add it to config.txt or as an environment variable (e.g., EVENT_CALENDAR_URL=https://luma.com/xxxx)."
        );
    }
    const maxRegistrationsSetting = parseInt(config["MAX_REGISTRATIONS_PER_RUN"] || "", 10);
    const maxRegistrations = Number.isNaN(maxRegistrationsSetting) ? Infinity : maxRegistrationsSetting;
    const timezone = config["TIMEZONE"] || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const dryRun = config["DRY_RUN"] === "true";
    if (dryRun) console.log("DRY_RUN=true: answers are prepared and logged, nothing is submitted.");

    const calendarApiId = await getCalendarApiId(eventCalendarUrl, cookieString);
    if (!calendarApiId) {
        console.error(`Failed to retrieve calendar_api_id from ${eventCalendarUrl}.`);
        return result;
    }
    console.log(`Using Calendar API ID: ${calendarApiId} extracted from ${eventCalendarUrl}`);

    const allEventEntries = await fetchAllEventEntriesFromCalendarApi(calendarApiId, cookieString);
    if (allEventEntries.length === 0) {
        console.log("No event entries found from the API.");
        return result;
    }
    console.log(`Found ${allEventEntries.length} total event entries from calendar API.`);

    let submittedCount = 0;
    for (const entry of allEventEntries) {
        if (entry.platform === "external" || !entry.event.api_id) {
            console.log(`\n--- Skipping external event (not hosted on Luma): ${entry.event.name} ---`);
            continue;
        }
        const eventSlug = entry.event.url;
        const eventUrl = `https://luma.com/${eventSlug}`;
        const eventApiId = entry.event.api_id;
        const eventName = entry.event.name;

        console.log(`\n--- Processing Event via API: ${eventName} (${eventUrl}) ---`);
        const approvalStatus = getApprovalStatus(entry);
        console.log(
            `  Event API ID: ${eventApiId}, Top-level Status: ${entry.status || "N/A"}, Your Approval: ${approvalStatus || "N/A"}`
        );

        if (approvalStatus && ALREADY_HANDLED_STATUSES.includes(approvalStatus)) {
            console.log(`  User has role approval status "${approvalStatus}" for "${eventName}". Skipping.`);
            successfulRegistrations.push(`${eventUrl} (Skipped, role approval: ${approvalStatus})`);
            continue;
        }

        if (submittedCount >= maxRegistrations) {
            console.log(`  Reached MAX_REGISTRATIONS_PER_RUN (${maxRegistrations}). Leaving remaining events for the next run.`);
            result.stoppedEarly = true;
            break;
        }

        // Add random delay between processing events (2-5 seconds)
        const eventDelay = Math.floor(Math.random() * 3000) + 2000;
        console.log(`  Adding delay between events: ${eventDelay}ms`);
        await new Promise((resolve) => setTimeout(resolve, eventDelay));

        try {
            const eventDetails = await fetchEventDetails(eventApiId);
            if (!eventDetails || !eventDetails.registration_questions || !eventDetails.ticket_types) {
                console.error(`  Could not fetch valid event details for ${eventApiId} from ${eventUrl}. Skipping.`);
                processingFailures.push(`${eventUrl} (Failed to fetch details)`);
                continue;
            }
            console.log(`  Fetched details for: ${eventName}`);
            console.log(`  Found ${eventDetails.registration_questions.length} registration questions.`);
            console.log(`  Found ${eventDetails.ticket_types.length} ticket types.`);

            // Find a suitable FREE ticket that is not hidden, not disabled, not sold out, and not expired
            const suitableTicket = eventDetails.ticket_types.find(
                (tt) =>
                    tt.type === "free" &&
                    !tt.is_hidden &&
                    !tt.is_disabled &&
                    !tt.is_sold_out &&
                    (!tt.valid_end_at || new Date(tt.valid_end_at) > new Date())
            );
            if (!suitableTicket) {
                console.warn(
                    `  No suitable (type === 'free', not hidden, not disabled, not sold out, not expired) ticket found for ${eventName}. Skipping.`
                );
                processingFailures.push(`${eventUrl} (No free ticket found)`);
                continue;
            }
            console.log(`  Selected ticket: ${suitableTicket.name} (ID: ${suitableTicket.api_id}, Type: ${suitableTicket.type})`);

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
                    eventDetails.registration_questions.some((q) => q.required))
            ) {
                console.error(`  Failed to prepare all required registration answers for ${eventName}. Skipping.`);
                processingFailures.push(`${eventUrl} (Answer preparation failed for required questions)`);
                continue;
            }
            if (
                eventDetails.registration_questions.length > 0 &&
                registrationAnswers.length !== eventDetails.registration_questions.length
            ) {
                console.warn(
                    `  Mismatch in prepared answers (${registrationAnswers.length}) vs questions (${eventDetails.registration_questions.length}) for ${eventName}. Proceeding cautiously.`
                );
            }

            const payload = {
                event_api_id: eventApiId,
                name: `${profile["Name"]}`,
                first_name: profile["First Name"] || profile["Name"]?.split(" ")[0] || "",
                last_name: profile["Last Name"] || profile["Name"]?.split(" ").slice(1).join(" ") || "",
                email: profile["Email"],
                phone_number: profileValue(profile, PHONE_KEYS),
                ticket_type_to_selection: {
                    [suitableTicket.api_id]: { count: 1, amount: 0 },
                },
                registration_answers: registrationAnswers,
                for_waitlist: false,
                timezone,
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

            submittedCount++;
            const logRecord = {
                at: new Date().toISOString(),
                account: accountId,
                dryRun,
                event: eventName,
                url: eventUrl,
                ticket: suitableTicket.name,
                phone_number: payload.phone_number ?? null,
                answers: eventDetails.registration_questions.map((q, i) => ({
                    label: q.label,
                    type: q.question_type,
                    required: q.required,
                    options: q.options,
                    answer: registrationAnswers[i]?.answer ?? null,
                })),
            };
            if (dryRun) {
                await logSubmission({ ...logRecord, result: "dry-run" });
                successfulRegistrations.push(`${eventUrl} (dry run)`);
                continue;
            }

            console.log(`  Submitting registration for ${eventName}...`);
            const submission = await submitRegistration(payload, cookieString, eventUrl);
            await logSubmission({
                ...logRecord,
                result: submission.ok ? "submitted" : submission.blocked ? `blocked ${submission.status}` : `failed ${submission.status ?? ""}`.trim(),
                response: submission.ok ? submission.data : undefined,
            });

            if (submission.ok) {
                console.log(
                    `  Registration submitted for ${eventName}. Response:`,
                    JSON.stringify(submission.data).substring(0, 200) + "..."
                );
                successfulRegistrations.push(eventUrl);
            } else if (submission.blocked) {
                console.warn(
                    `\x1b[33m  Luma returned ${submission.status} (rate limited / blocked). Stopping registrations for this account until the next run.\x1b[0m`
                );
                processingFailures.push(`${eventUrl} (Blocked with status ${submission.status}, stopped run)`);
                result.stoppedEarly = true;
                break;
            } else {
                console.error(`  Registration submission failed for ${eventName}.`);
                processingFailures.push(`${eventUrl} (Submission API call failed)`);
            }
        } catch (eventError) {
            console.error(`  Error processing event ${eventName} (${eventUrl}) with API flow:`, eventError);
            processingFailures.push(`${eventUrl} (Runtime error in API flow for ${eventName})`);
        }
    }

    return result;
}

export function printRunSummary(result: AccountRunResult): void {
    const { successfulRegistrations, processingFailures } = result;
    if (successfulRegistrations.length > 0) {
        console.log(`\n--- Successfully processed ${successfulRegistrations.length} event(s): ---`);
        successfulRegistrations.forEach((url) => console.log(`  - ${url}`));
    }
    if (processingFailures.length > 0) {
        console.warn(`\n--- Processing failed for ${processingFailures.length} event(s): ---`);
        processingFailures.forEach((url) => console.warn(`  - ${url}`));
    } else if (successfulRegistrations.length === 0) {
        console.log("\nNo events were successfully registered, and no failures were explicitly recorded beyond initial skips.");
    }
    if (result.stoppedEarly) {
        console.log("Run stopped early; remaining events will be picked up on the next run.");
    }
}
