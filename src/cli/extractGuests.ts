// Extracts the participants' Luma profile links for every event of one or more calendars.
//
// For each event, the COOKIES_ACCOUNT_<ID> sessions that are guests of it (approved or invited)
// are tried in turn: Luma only returns the full guest list to a guest, and only when the host
// shows the guest list. That endpoint is rate-limited per IP, so other accounts are not asked.
// Otherwise we fall back to the featured guests (up to 10) Luma shows on the event card. Events whose host hides the guest list have no participants to extract.
// Once an event's guests are fetched, each new participant's profile page is visited for their
// avatar, bio, socials and event stats. Profiles are cached, so each person is visited once.
//
// Usage: npm run extract-guests -- [calendar URLs...] [--period=future|past|all] [--limit=N]
//        [--accounts=one,two] [--slow] [--guest-only] [--no-profiles] [--resume] [--events]
// --events takes event URLs instead of calendar URLs, each written to output/event_<slug>_*.csv
// and output/<event name>.json.
// --resume skips the events already done by a previous run (saved in output/<calendar>_state.json).
// --no-profiles skips the profile visits: the guest list already has avatar, bio and socials.
// --guest-only keeps only the events whose full guest list an account can see.
// --slow spaces requests about 4x more and waits 10 minutes (then 20, 30...) when rate-limited.
// Calendars default to EVENT_CALENDAR_URL. Output goes to output/<calendar>_*.csv, plus
// output/<calendar>_leads.json with one object per unique person.
import axios from "axios";
import * as fs from "fs";
import path from "path";
import { readConfig } from "../api_flow/config";
import { getEventApiIdFromUrl } from "../api_flow/api_helper";
import { getCalendarApiId, normalizeLumaCookie } from "../api_flow/lumaRunner";

const OUTPUT_DIR = path.resolve(__dirname, "../../output");
const COOKIE_KEY_PREFIX = "COOKIES_ACCOUNT_";
const USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

interface LumaUser {
    api_id: string;
    name: string | null;
    first_name: string | null;
    last_name: string | null;
    username: string | null;
    avatar_url: string | null;
    bio_short: string | null;
    twitter_handle: string | null;
    linkedin_handle: string | null;
    instagram_handle: string | null;
    tiktok_handle: string | null;
    youtube_handle: string | null;
    website: string | null;
    timezone: string | null;
}

// Extra data only found on the profile page.
interface ProfileStats {
    event_attended_count: number | null;
    event_hosted_count: number | null;
    joined_at: string | null;
}

interface Person {
    user: LumaUser;
    stats: ProfileStats | null;
    events: string[];
}

interface CalendarEntry {
    event: { api_id: string; name: string; url: string; start_at: string; show_guest_list?: boolean };
    platform?: string;
    guest_count?: number;
    guest_info?: { approval_status?: string } | null;
    featured_guests?: LumaUser[];
}

type Access = "full" | "featured" | "hidden";

interface Account {
    id: string;
    cookie: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Multiplies every delay between requests, set by --slow.
let pace = 1;

// Guest statuses that can see the guest list. Others (pending, waitlist, not registered) get HTTP 403.
const GUEST_STATUSES = ["approved", "invited"];

// event/get-guest-list is rate-limited per IP, much more strictly than the other endpoints.
const SLOW_PATHS = ["event/get-guest-list"];

// GET on api.luma.com, retrying with backoff when rate-limited or when the network fails
// (DNS, timeout, reset). Returns the status and body.
async function lumaGet(apiPath: string, params: Record<string, string | number>, cookie: string): Promise<{ status: number; data: any }> {
    const slow = SLOW_PATHS.includes(apiPath);
    let networkFailures = 0;
    for (let attempt = 1; ; attempt++) {
        await sleep(pace * (slow ? 1500 + Math.random() * 1000 : 300 + Math.random() * 400));
        let response;
        try {
            response = await axios.get(`https://api.luma.com/${apiPath}`, {
                params,
                headers: { Accept: "application/json", Origin: "https://luma.com", "User-Agent": USER_AGENT, cookie },
                validateStatus: () => true,
                timeout: 30000,
            });
        } catch (error: any) {
            if (++networkFailures === 10) throw error;
            const wait = 30000 * networkFailures;
            console.warn(`  Network error on ${apiPath} (${error.code ?? error.message}), retrying in ${wait / 1000}s...`);
            await sleep(wait);
            attempt--;
            continue;
        }
        if (response.status !== 429 || attempt === 5) return { status: response.status, data: response.data };
        const wait = (pace > 1 ? 600000 : slow ? 60000 : 15000) * attempt;
        console.warn(`  Rate-limited on ${apiPath}, waiting ${wait / 1000}s...`);
        await sleep(wait);
    }
}

// The calendar's Luma-hosted events, with this account's guest status. Stops paging at `limit`.
async function fetchCalendarEntries(calendarApiId: string, period: string, limit: number, cookie: string): Promise<CalendarEntry[]> {
    const entries: CalendarEntry[] = [];
    const periods = period === "all" ? ["future", "past"] : [period];
    for (const p of periods) {
        let cursor: string | undefined;
        do {
            const params: Record<string, string | number> = { calendar_api_id: calendarApiId, period: p, pagination_limit: 50 };
            if (cursor) params.pagination_cursor = cursor;
            const { status, data } = await lumaGet("calendar/get-items", params, cookie);
            if (status !== 200) throw new Error(`calendar/get-items returned HTTP ${status}`);
            entries.push(...data.entries.filter((entry: CalendarEntry) => entry.platform !== "external" && entry.event?.api_id));
            cursor = data.has_more && entries.length < limit ? data.next_cursor : undefined;
            process.stdout.write(`\r  ${p}: ${entries.length} events`);
        } while (cursor);
        console.log();
        if (entries.length >= limit) break;
    }
    return entries.slice(0, limit);
}

// The full guest list, or null when this account can't see it (HTTP 403).
async function fetchGuestList(eventApiId: string, cookie: string): Promise<LumaUser[] | null> {
    const guests: LumaUser[] = [];
    let cursor: string | undefined;
    do {
        const params: Record<string, string | number> = { event_api_id: eventApiId, pagination_limit: 100 };
        if (cursor) params.pagination_cursor = cursor;
        const { status, data } = await lumaGet("event/get-guest-list", params, cookie);
        if (status !== 200) {
            if (guests.length === 0) return null;
            console.warn(`  Guest list stopped at ${guests.length} guests (HTTP ${status})`);
            break;
        }
        guests.push(...data.entries.map((entry: { user: LumaUser }) => entry.user));
        cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);
    return guests;
}

// Reads the profile page's __NEXT_DATA__. Returns null when the page can't be read.
async function fetchProfile(user: LumaUser): Promise<{ user: LumaUser; stats: ProfileStats } | null> {
    await sleep(pace * (300 + Math.random() * 400));
    try {
        const response = await axios.get<string>(profileUrl(user), {
            headers: { Accept: "text/html", "User-Agent": USER_AGENT },
            validateStatus: () => true,
            timeout: 30000,
        });
        if (response.status !== 200) return null;
        const match = response.data.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
        const data = match && JSON.parse(match[1]).props?.pageProps?.initialData;
        if (!data?.user) return null;
        return {
            user: { ...user, ...data.user },
            stats: {
                event_attended_count: data.event_attended_count ?? null,
                event_hosted_count: data.event_hosted_count ?? null,
                joined_at: data.joined_at ?? null,
            },
        };
    } catch {
        return null;
    }
}

function profileUrl(user: LumaUser): string {
    return `https://luma.com/user/${user.username || user.api_id}`;
}

function socialUrl(base: string, handle: string | null): string {
    if (!handle) return "";
    return handle.startsWith("http") ? handle : `${base}${handle.replace(/^\//, "")}`;
}

function csvCell(value: unknown): string {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(file: string, header: string[], rows: unknown[][]): void {
    const lines = [header, ...rows].map((row) => row.map(csvCell).join(","));
    fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
}

function userColumns(user: LumaUser): string[] {
    return [
        user.name ?? "",
        profileUrl(user),
        socialUrl("https://x.com/", user.twitter_handle),
        socialUrl("https://www.linkedin.com/", user.linkedin_handle),
        socialUrl("https://www.instagram.com/", user.instagram_handle),
        user.website ?? "",
        user.bio_short ?? "",
    ];
}
const USER_HEADER = ["name", "luma_profile", "twitter", "linkedin", "instagram", "website", "bio"];

const PEOPLE_HEADER = [
    "luma_user_id", "name", "first_name", "last_name", "username", "luma_profile", "avatar_url", "bio",
    "twitter", "linkedin", "instagram", "tiktok", "youtube", "website", "timezone",
    "luma_events_attended", "luma_events_hosted", "luma_joined_at", "profile_fetched",
    "event_count", "events",
];

function personRow({ user, stats, events }: Person): unknown[] {
    return [
        user.api_id, user.name, user.first_name, user.last_name, user.username, profileUrl(user), user.avatar_url, user.bio_short,
        socialUrl("https://x.com/", user.twitter_handle),
        socialUrl("https://www.linkedin.com/", user.linkedin_handle),
        socialUrl("https://www.instagram.com/", user.instagram_handle),
        socialUrl("https://www.tiktok.com/@", user.tiktok_handle),
        socialUrl("https://www.youtube.com/@", user.youtube_handle),
        user.website, user.timezone,
        stats?.event_attended_count, stats?.event_hosted_count, stats?.joined_at, stats ? "yes" : "no",
        events.length, events.join(" | "),
    ];
}

function personLead({ user, stats, events }: Person): Record<string, unknown> {
    return {
        luma_user_id: user.api_id,
        name: user.name,
        first_name: user.first_name,
        last_name: user.last_name,
        username: user.username,
        luma_profile: profileUrl(user),
        avatar_url: user.avatar_url,
        bio: user.bio_short,
        twitter: socialUrl("https://x.com/", user.twitter_handle) || null,
        linkedin: socialUrl("https://www.linkedin.com/", user.linkedin_handle) || null,
        instagram: socialUrl("https://www.instagram.com/", user.instagram_handle) || null,
        tiktok: socialUrl("https://www.tiktok.com/@", user.tiktok_handle) || null,
        youtube: socialUrl("https://www.youtube.com/@", user.youtube_handle) || null,
        website: user.website,
        timezone: user.timezone,
        luma_events_attended: stats?.event_attended_count ?? null,
        luma_events_hosted: stats?.event_hosted_count ?? null,
        luma_joined_at: stats?.joined_at ?? null,
        events,
    };
}

interface RunState {
    eventRows: unknown[][];
    guestRows: unknown[][];
    people: [string, Person][];
    accessCounts: Record<Access, number>;
}

async function extractCalendar(calendarUrl: string, period: string, limit: number, guestOnly: boolean, visitProfiles: boolean, resume: boolean, accounts: Account[]): Promise<void> {
    console.log(`\n=== ${calendarUrl} (${period} events)`);
    const calendarApiId = await getCalendarApiId(calendarUrl, accounts[0].cookie);
    if (!calendarApiId) {
        console.error(`  Could not find the calendar id of ${calendarUrl}, skipping.`);
        return;
    }
    // Each account's calendar view tells whether it is a guest of each event.
    // With --guest-only the whole calendar is read, since guest events can be anywhere in it.
    const fetchLimit = guestOnly ? Infinity : limit;
    let entries = await fetchCalendarEntries(calendarApiId, period, fetchLimit, accounts[0].cookie);
    const guestAccounts = new Map<string, Account[]>();
    for (const account of accounts) {
        const accountEntries = account === accounts[0] ? entries : await fetchCalendarEntries(calendarApiId, period, fetchLimit, account.cookie);
        for (const entry of accountEntries) {
            if (!GUEST_STATUSES.includes(entry.guest_info?.approval_status ?? "")) continue;
            guestAccounts.set(entry.event.api_id, [...(guestAccounts.get(entry.event.api_id) ?? []), account]);
        }
    }
    console.log(`  ${guestAccounts.size}/${entries.length} events have an account that is a guest.`);
    if (guestOnly) {
        entries = entries
            .filter((entry) => guestAccounts.has(entry.event.api_id) && entry.event.show_guest_list !== false && (entry.guest_count ?? 0) > 0)
            .slice(0, limit);
        console.log(`  --guest-only: processing ${entries.length} events with a visible guest list.`);
    }

    const slug = new URL(calendarUrl).pathname.replace(/^\/|\/$/g, "").replace(/[^a-zA-Z0-9_-]+/g, "_") || calendarApiId;
    await processEntries(path.join(OUTPUT_DIR, slug), entries, guestAccounts, visitProfiles, resume);
}

// A single event page, read through event/get with each account to know whether it is a guest.
async function extractEvent(eventUrl: string, visitProfiles: boolean, resume: boolean, accounts: Account[]): Promise<void> {
    console.log(`\n=== ${eventUrl}`);
    const eventApiId = await getEventApiIdFromUrl(eventUrl);
    if (!eventApiId) {
        console.error(`  Could not find the event id of ${eventUrl}, skipping.`);
        return;
    }
    let entry: CalendarEntry | null = null;
    const guestAccounts = new Map<string, Account[]>();
    for (const account of accounts) {
        const { status, data } = await lumaGet("event/get", { event_api_id: eventApiId }, account.cookie);
        if (status !== 200) {
            console.warn(`  event/get returned HTTP ${status} for account ${account.id}`);
            continue;
        }
        entry ??= { event: data.event, guest_count: data.guest_count, featured_guests: data.featured_guests };
        const approvalStatus = data.guest_info?.approval_status ?? data.guest_data?.approval_status;
        console.log(`  Account ${account.id}: ${approvalStatus ?? "not registered"}`);
        if (GUEST_STATUSES.includes(approvalStatus ?? "")) {
            guestAccounts.set(eventApiId, [...(guestAccounts.get(eventApiId) ?? []), account]);
        }
    }
    if (!entry) {
        console.error(`  Could not read ${eventUrl}, skipping.`);
        return;
    }
    const slug = new URL(eventUrl).pathname.replace(/^\/|\/$/g, "").replace(/[^a-zA-Z0-9_-]+/g, "_") || eventApiId;
    const base = path.join(OUTPUT_DIR, `event_${slug}`);
    await processEntries(base, [entry], guestAccounts, visitProfiles, resume);
    // The leads of a single event are named after it.
    const leadsFile = path.join(OUTPUT_DIR, `${entry.event.name.replace(/[\/\\:*?"<>|·]+/g, "-").replace(/\s+/g, " ").trim()}.json`);
    fs.renameSync(`${base}_leads.json`, leadsFile);
    console.log(`  Leads: ${path.relative(process.cwd(), leadsFile)}`);
}

async function processEntries(
    base: string,
    entries: CalendarEntry[],
    guestAccounts: Map<string, Account[]>,
    visitProfiles: boolean,
    resume: boolean
): Promise<void> {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const stateFile = `${base}_state.json`;
    const state: RunState =
        resume && fs.existsSync(stateFile)
            ? JSON.parse(fs.readFileSync(stateFile, "utf8"))
            : { eventRows: [], guestRows: [], people: [], accessCounts: { full: 0, featured: 0, hidden: 0 } };
    const { eventRows, guestRows, accessCounts } = state;
    const people = new Map<string, Person>(state.people);
    const doneEvents = new Set(eventRows.map((row) => row[1]));
    if (resume) console.log(`  --resume: ${doneEvents.size} events already done, ${people.size} people.`);

    // Rewritten after every event, so a stopped run keeps what it fetched.
    const writeOutputs = () => {
        fs.writeFileSync(stateFile, JSON.stringify({ eventRows, guestRows, people: [...people.entries()], accessCounts }));
        writeCsv(`${base}_events.csv`, ["event", "event_url", "start_at", "access", "guests_extracted", "guest_count"], eventRows);
        writeCsv(`${base}_guests_by_event.csv`, ["event", "event_url", "start_at", "access", ...USER_HEADER], guestRows);
        const sortedPeople = [...people.values()].sort((a, b) => b.events.length - a.events.length);
        writeCsv(`${base}_people.csv`, PEOPLE_HEADER, sortedPeople.map(personRow));
        fs.writeFileSync(`${base}_leads.json`, JSON.stringify(sortedPeople.map(personLead), null, 2));
    };

    for (const [index, entry] of entries.entries()) {
        const event = entry.event;
        const eventUrl = `https://luma.com/${event.url}`;
        if (doneEvents.has(eventUrl)) continue;
        let guests: LumaUser[] | null = null;
        let via = "";
        // Hosts that hide the guest list hide it from guests too, no need to ask.
        if (event.show_guest_list !== false && (entry.guest_count ?? 0) > 0) {
            for (const account of guestAccounts.get(event.api_id) ?? []) {
                guests = await fetchGuestList(event.api_id, account.cookie);
                if (guests) {
                    via = account.id;
                    break;
                }
            }
        }
        let access: Access = "full";
        if (!guests) {
            guests = entry.featured_guests ?? [];
            access = guests.length > 0 ? "featured" : "hidden";
        }
        accessCounts[access]++;
        console.log(
            `  [${index + 1}/${entries.length}] ${event.name.slice(0, 60)} -> ${access}, ${guests.length}/${entry.guest_count ?? "?"} guests${via ? ` (via ${via})` : ""}`
        );

        eventRows.push([event.name, eventUrl, event.start_at, access, guests.length, entry.guest_count ?? ""]);
        const newPeople: Person[] = [];
        for (const user of guests) {
            guestRows.push([event.name, eventUrl, event.start_at, access, ...userColumns(user)]);
            let person = people.get(user.api_id);
            if (!person) {
                person = { user, stats: null, events: [] };
                people.set(user.api_id, person);
                newPeople.push(person);
            }
            person.events.push(event.name);
        }

        // The event's guest list is complete, now visit the profiles of the people not seen yet.
        let failed = 0;
        for (const [i, person] of (visitProfiles ? newPeople : []).entries()) {
            process.stdout.write(`\r    profiles ${i + 1}/${newPeople.length}`);
            const profile = await fetchProfile(person.user);
            if (profile) {
                person.user = profile.user;
                person.stats = profile.stats;
            } else {
                failed++;
            }
        }
        if (visitProfiles && newPeople.length > 0) console.log(failed ? ` (${failed} could not be read)` : "");
        writeOutputs();
    }
    writeOutputs();

    console.log(
        `  Done: ${entries.length} events (full list: ${accessCounts.full}, featured only: ${accessCounts.featured}, hidden: ${accessCounts.hidden}), ${people.size} unique people.`
    );
    console.log(`  Wrote ${path.relative(process.cwd(), base)}_{events,guests_by_event,people}.csv and _leads.json`);
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const period = args.find((arg) => arg.startsWith("--period="))?.split("=")[1] ?? "all";
    if (!["future", "past", "all"].includes(period)) throw new Error(`--period must be future, past or all, got "${period}"`);
    const limitArg = args.find((arg) => arg.startsWith("--limit="))?.split("=")[1];
    const limit = limitArg ? parseInt(limitArg, 10) : Infinity;
    if (Number.isNaN(limit) || limit < 1) throw new Error(`--limit must be a positive number, got "${limitArg}"`);
    if (args.includes("--slow")) pace = 4;
    const guestOnly = args.includes("--guest-only");
    const visitProfiles = !args.includes("--no-profiles");
    const resume = args.includes("--resume");
    const eventMode = args.includes("--events");
    const accountFilter = args.find((arg) => arg.startsWith("--accounts="))?.split("=")[1].toLowerCase().split(",");

    const config = await readConfig();
    const calendarUrls = args.filter((arg) => !arg.startsWith("--"));
    if (eventMode && calendarUrls.length === 0) throw new Error("--events needs at least one event URL.");
    if (calendarUrls.length === 0) calendarUrls.push(...(config["EVENT_CALENDAR_URL"] ?? "").split(",").map((url) => url.trim()).filter(Boolean));
    if (calendarUrls.length === 0) throw new Error("No calendar URL given and EVENT_CALENDAR_URL is not set.");

    const accounts: Account[] = [];
    const cookieValues: Record<string, string> = {};
    for (const source of [config, process.env]) {
        for (const [key, value] of Object.entries(source)) {
            if (key.startsWith(COOKIE_KEY_PREFIX) && value) cookieValues[key] = value;
        }
    }
    for (const key of Object.keys(cookieValues).sort()) {
        const cookie = normalizeLumaCookie(cookieValues[key]);
        const id = key.slice(COOKIE_KEY_PREFIX.length).toLowerCase();
        if (cookie && (!accountFilter || accountFilter.includes(id))) accounts.push({ id, cookie });
    }
    if (accounts.length === 0) throw new Error(`No ${COOKIE_KEY_PREFIX}<ID> cookie found in config.txt or the environment.`);
    console.log(`Using accounts: ${accounts.map((account) => account.id).join(", ")}`);

    if (eventMode) {
        for (const eventUrl of calendarUrls) await extractEvent(eventUrl, visitProfiles, resume, accounts);
        return;
    }
    for (const calendarUrl of calendarUrls) {
        await extractCalendar(calendarUrl, period, limit, guestOnly, visitProfiles, resume, accounts);
    }
}

main().catch((error) => {
    console.error("\x1b[31mGuest extraction failed:\x1b[0m", error.message ?? error);
    process.exit(1);
});
