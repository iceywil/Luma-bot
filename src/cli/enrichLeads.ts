// Enriches leads (from extract-guests) with title, company, company blurb, vertical and chains.
//
// Evidence gathered per lead, all without logging in:
// - the Luma bio
// - the X profile (bio, website, location, followers) through X's logged-out guest access
// - the X accounts mentioned in the bios (usually the company, e.g. "Founder @BlockTides")
// - the website's title and description
// - the LinkedIn company page description (personal LinkedIn profiles need a login, so no)
// Claude then reads the evidence of a batch of leads and fills the fields.
//
// Leads are processed most promising first: real profile picture and bio, then most events.
// Our own accounts (the COOKIES_ACCOUNT_<ID> users) are left out.
// Results go to <input>_enriched.json/.csv, rewritten after every batch; a rerun continues where
// the previous one stopped. X profiles and websites are cached in output/enrich_cache.json.
//
// Usage: npm run enrich-leads -- [leads.json] [--limit=N] [--target=N] [--batch=15]
// --limit enriches N more leads this run; --target stops once N leads are enriched in total,
// so a restarted run doesn't go past it.
import axios from "axios";
import { promises as dns } from "dns";
import * as fs from "fs";
import path from "path";
import { readConfig } from "../api_flow/config";
import { callClaude } from "../api_flow/llm";
import { normalizeLumaCookie } from "../api_flow/lumaRunner";

// OUTPUT_DIR points at a volume on the server (e.g. /data on Railway).
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.resolve(__dirname, "../../output");
const CACHE_FILE = path.join(OUTPUT_DIR, "enrich_cache.json");
const DEFAULT_AVATAR = "https://cdn.lu.ma/avatars-default/";
const USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
// The public bearer token of the x.com web app, used by every logged-out visitor.
const X_BEARER =
    "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const X_USER_QUERY = "xmU6X_CKVnQ5lSrCbAmJsg/UserByScreenName";
const X_FEATURES = {
    hidden_profile_subscriptions_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    highlights_tweets_tab_ui_enabled: true,
    responsive_web_twitter_article_notes_tab_enabled: true,
    subscriptions_feature_can_gift_premium: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true,
};

const VERTICALS = [
    "L1/L2 & Infrastructure", "DeFi", "Exchange (CEX)", "Trading & Market Making", "Wallet & Custody",
    "Payments & Stablecoins", "RWA & Tokenization", "Gaming & NFT", "AI", "Data & Analytics",
    "Developer Tools", "Security & Audit", "VC & Investment", "Media, PR & Marketing", "Events & Community",
    "Consulting & Services", "Legal & Compliance", "Traditional Finance", "Non-crypto", "Unknown",
];

// Blockchain networks a company can build on. Claude picks from these, anything else is dropped.
const CHAINS = [
    "Multi-chain", "Bitcoin", "Ethereum", "Solana", "Base", "Arbitrum", "Optimism", "Polygon", "BNB Chain",
    "Avalanche", "Sui", "Aptos", "TON", "Tron", "Cosmos", "Polkadot", "NEAR", "Cardano", "XRP Ledger", "Stellar",
    "Hedera", "Starknet", "zkSync", "Linea", "Scroll", "Mantle", "Blast", "Berachain", "Monad", "MegaETH",
    "Hyperliquid", "Sei", "Injective", "Celestia", "Algorand", "Tezos", "Sonic", "Cronos", "Kaia", "Movement",
    "Story", "Canton", "Plasma", "Stable", "Bittensor", "Filecoin", "Internet Computer", "Lightning", "Stacks",
    "Flow", "Kaspa", "Litecoin", "Dogecoin", "Ronin", "Immutable", "Abstract", "Unichain", "World Chain", "Plume",
];
const CHAIN_BY_KEY = new Map(CHAINS.map((chain) => [chain.toLowerCase().replace(/[^a-z0-9]/g, ""), chain]));

function normalizeChains(chains: unknown): string[] {
    if (!Array.isArray(chains)) return [];
    const known = chains
        .map((chain) => CHAIN_BY_KEY.get(String(chain).toLowerCase().replace(/[^a-z0-9]/g, "")))
        .filter((chain): chain is string => Boolean(chain));
    return [...new Set(known)];
}

interface XProfile {
    name: string | null;
    bio: string | null;
    website: string | null;
    location: string | null;
    followers: number | null;
}

interface PageInfo {
    title: string | null;
    description: string | null;
}

interface Cache {
    x: Record<string, XProfile | null>;
    pages: Record<string, PageInfo | null>;
}

interface Enrichment {
    title: string | null;
    company: string | null;
    company_website: string | null;
    company_blurb: string | null;
    vertical: string | null;
    chains: string[];
    confidence: "high" | "medium" | "low";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Blocks while the internet is down (DNS fails), so an outage doesn't burn through retries.
async function waitForNetwork(): Promise<void> {
    for (let waited = 0; ; waited += 30) {
        try {
            await dns.lookup("api.x.com");
            if (waited > 0) console.log(`  Network is back after ${waited}s.`);
            return;
        } catch {
            if (waited === 0) console.warn("  Network is down, waiting for it to come back...");
            await sleep(30000);
        }
    }
}

// --- X guest access ---

let guestToken: string | null = null;
// Gap between X requests. Starts short, doubles when X rate-limits us, and shrinks back slowly.
const X_MIN_DELAY = 400;
const X_MAX_DELAY = 8000;
let xDelay = X_MIN_DELAY;

async function refreshGuestToken(): Promise<void> {
    const response = await axios.post("https://api.x.com/1.1/guest/activate.json", null, {
        headers: { authorization: `Bearer ${X_BEARER}`, "User-Agent": USER_AGENT },
        timeout: 30000,
    });
    guestToken = response.data.guest_token;
}

function xHandle(url: string | null): string | null {
    const match = url?.match(/(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})/);
    return match ? match[1].toLowerCase() : null;
}

// Fetches a profile through the guest token. null when the account doesn't exist or is suspended,
// undefined when X couldn't be asked (network, rate limit), so the answer isn't cached.
async function fetchXProfile(handle: string): Promise<XProfile | null | undefined> {
    for (let attempt = 1; attempt <= 6; attempt++) {
        await sleep(xDelay + Math.random() * xDelay * 0.5);
        try {
            if (!guestToken) await refreshGuestToken();
            const response = await axios.get(`https://api.x.com/graphql/${X_USER_QUERY}`, {
                params: { variables: JSON.stringify({ screen_name: handle }), features: JSON.stringify(X_FEATURES) },
                headers: { authorization: `Bearer ${X_BEARER}`, "x-guest-token": guestToken, "User-Agent": USER_AGENT },
                validateStatus: () => true,
                timeout: 30000,
            });
            if (response.status === 429 || response.status === 403) {
                // Guest tokens expire and are rate-limited; a new one usually fixes it, otherwise wait.
                guestToken = null;
                if (response.status === 429) xDelay = Math.min(xDelay * 2, X_MAX_DELAY);
                const wait = response.status === 429 ? 60000 * attempt : 5000;
                console.warn(`    X returned ${response.status} for @${handle}, retrying in ${wait / 1000}s (gap now ${xDelay}ms)...`);
                await sleep(wait);
                continue;
            }
            xDelay = Math.max(X_MIN_DELAY, Math.round(xDelay * 0.98));
            const user = response.data?.data?.user?.result;
            const legacy = user?.legacy;
            if (response.status !== 200 || !legacy) return null;
            let bio: string = legacy.description ?? "";
            for (const url of legacy.entities?.description?.urls ?? []) bio = bio.replace(url.url, url.expanded_url);
            return {
                name: legacy.name ?? user.core?.name ?? null,
                bio: bio || null,
                website: legacy.entities?.url?.urls?.[0]?.expanded_url ?? null,
                location: legacy.location || null,
                followers: legacy.followers_count ?? null,
            };
        } catch (error: any) {
            console.warn(`    X request failed for @${handle} (${error.code ?? error.message}), retrying...`);
            await waitForNetwork();
            await sleep(5000 * attempt);
        }
    }
    return undefined;
}

// --- Web pages ---

function decodeEntities(text: string): string {
    return text
        .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

// Title and description of a page, null when the site has none or refuses us, undefined when
// the request didn't go through (network), so the answer isn't cached.
async function fetchPageInfo(url: string): Promise<PageInfo | null | undefined> {
    await sleep(500);
    try {
        const response = await axios.get<string>(url, {
            headers: { "User-Agent": USER_AGENT, Accept: "text/html", "Accept-Language": "en-US,en" },
            timeout: 15000,
            maxContentLength: 3_000_000,
            responseType: "text",
            validateStatus: () => true,
        });
        if (response.status !== 200) return null;
        const html = String(response.data);
        const meta = (name: string) =>
            html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']*)`, "i"))?.[1] ??
            html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${name}["']`, "i"))?.[1];
        const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? meta("og:title");
        const description = meta("description") ?? meta("og:description");
        if (!title && !description) return null;
        return {
            title: title ? decodeEntities(title).trim().slice(0, 200) : null,
            description: description ? decodeEntities(description).trim().slice(0, 500) : null,
        };
    } catch (error: any) {
        // An error without a response is the network (or the site is down): don't cache it.
        return error.response ? null : undefined;
    }
}

function normalizeUrl(url: string | null): string | null {
    if (!url) return null;
    const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    try {
        const parsed = new URL(withScheme);
        return parsed.hostname.includes(".") ? parsed.toString() : null;
    } catch {
        return null;
    }
}

// --- Evidence ---

type Lead = Record<string, any>;

function priority(lead: Lead): [number, number] {
    const hasPfp = Boolean(lead.avatar_url) && !String(lead.avatar_url).startsWith(DEFAULT_AVATAR);
    const hasBio = Boolean(lead.bio?.trim());
    return [(hasPfp ? 1 : 0) + (hasBio ? 1 : 0), (lead.events ?? []).length];
}

async function gatherEvidence(lead: Lead, cache: Cache): Promise<Record<string, unknown>> {
    const cachedX = async (handle: string) => {
        if (handle in cache.x) return cache.x[handle];
        const profile = await fetchXProfile(handle);
        if (profile !== undefined) cache.x[handle] = profile;
        return profile ?? null;
    };
    const cachedPage = async (url: string) => {
        if (url in cache.pages) return cache.pages[url];
        const page = await fetchPageInfo(url);
        if (page !== undefined) cache.pages[url] = page;
        return page ?? null;
    };

    const handle = xHandle(lead.twitter);
    const x = handle ? await cachedX(handle) : null;

    // Accounts mentioned in the bios are usually the person's company or project.
    const mentions = [...new Set(`${lead.bio ?? ""} ${x?.bio ?? ""}`.match(/@([A-Za-z0-9_]{2,15})\b/g) ?? [])]
        .map((mention) => mention.slice(1).toLowerCase())
        .filter((mention) => mention !== handle)
        .slice(0, 2);
    const mentioned: Record<string, unknown>[] = [];
    for (const mention of mentions) {
        const profile = await cachedX(mention);
        if (profile) mentioned.push({ handle: `@${mention}`, name: profile.name, bio: profile.bio, website: profile.website });
    }

    const website = normalizeUrl(lead.website) ?? normalizeUrl(x?.website ?? null);
    const page = website ? await cachedPage(website) : null;
    const linkedinCompany = /linkedin\.com\/company\//.test(lead.linkedin ?? "") ? await cachedPage(lead.linkedin) : null;

    return {
        id: lead.luma_user_id,
        name: lead.name,
        luma_bio: lead.bio,
        x_handle: handle ? `@${handle}` : null,
        x_name: x?.name,
        x_bio: x?.bio,
        x_location: x?.location,
        x_followers: x?.followers,
        linkedin_url: lead.linkedin,
        linkedin_company_page: linkedinCompany,
        website,
        website_page: page,
        mentioned_accounts: mentioned,
        events: (lead.events ?? []).slice(0, 8),
    };
}

// --- Claude ---

const SYSTEM_PROMPT = `You enrich crypto/web3 event attendee leads for B2B outreach. You get evidence about each person (Luma bio, X profile, accounts they mention, website, LinkedIn company page, events attended) and return structured fields. Only state what the evidence supports; use null when unknown. Return only JSON.`;

function buildPrompt(evidence: Record<string, unknown>[]): string {
    return `For each person below, return an object with:
- "id": the id given
- "title": their current role, short (e.g. "Co-Founder", "Head of BD", "Investor"); null if unknown
- "company": their current company or project name; null if unknown or self-employed without a brand
- "company_website": the company's website if known from the evidence, else null
- "company_blurb": one or two sentences on what the company does, from the evidence; null if unknown
- "vertical": exactly one of ${JSON.stringify(VERTICALS)}
- "chains": the blockchain networks the company builds on or focuses on, only from ${JSON.stringify(CHAINS)}. Never a company or token name. ["Multi-chain"] if chain-agnostic, [] if unknown or not applicable (agencies, funds, law firms...)
- "confidence": "high" if title and company are stated explicitly, "medium" if inferred, "low" if guessed from little

Return a JSON array with one object per person, in the same order, and nothing else.

People:
${JSON.stringify(evidence, null, 1)}`;
}

function parseJsonArray(text: string): any[] | null {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start === -1 || end <= start) return null;
    try {
        const parsed = JSON.parse(text.slice(start, end + 1));
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

// Enriches a batch. Leads missing from Claude's answer are asked again on their own, up to twice.
async function enrichBatch(evidence: Record<string, unknown>[], config: Record<string, string>): Promise<Map<string, Enrichment>> {
    const results = await askClaude(evidence, config);
    for (let retry = 1; retry <= 2; retry++) {
        const missing = evidence.filter((proof) => !results.has(proof.id as string));
        if (missing.length === 0) break;
        console.warn(`    ${missing.length} lead(s) missing from Claude's answer, asking again (${retry}/2)...`);
        for (const [id, enrichment] of await askClaude(missing, config)) results.set(id, enrichment);
    }
    return results;
}

async function askClaude(evidence: Record<string, unknown>[], config: Record<string, string>): Promise<Map<string, Enrichment>> {
    const ids = new Set(evidence.map((proof) => proof.id));
    for (let attempt = 1; attempt <= 3; attempt++) {
        await waitForNetwork();
        try {
            const result = await callClaude(buildPrompt(evidence), config, SYSTEM_PROMPT, 300000);
            const items = parseJsonArray(result.text);
            if (items) {
                const byId = new Map<string, Enrichment>();
                for (const item of items) {
                    if (!ids.has(item?.id)) continue;
                    byId.set(item.id, {
                        title: item.title ?? null,
                        company: item.company ?? null,
                        company_website: item.company_website ?? null,
                        company_blurb: item.company_blurb ?? null,
                        vertical: VERTICALS.includes(item.vertical) ? item.vertical : "Unknown",
                        chains: normalizeChains(item.chains),
                        confidence: ["high", "medium", "low"].includes(item.confidence) ? item.confidence : "low",
                    });
                }
                return byId;
            }
            console.warn(`    Claude's answer was not a JSON array (attempt ${attempt}/3)`);
        } catch (error: any) {
            console.warn(`    Claude call failed (attempt ${attempt}/3): ${error.message}`);
        }
        await sleep(10000 * attempt);
    }
    return new Map();
}

// --- Output ---

const CSV_COLUMNS = [
    "luma_user_id", "name", "username", "luma_profile", "title", "company", "company_website", "company_blurb",
    "vertical", "chains", "confidence", "bio", "x_bio", "x_location", "x_followers", "twitter", "linkedin",
    "instagram", "website", "avatar_url", "event_count", "events",
];

function csvCell(value: unknown): string {
    const text = value === null || value === undefined ? "" : Array.isArray(value) ? value.join(" | ") : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeOutputs(base: string, enriched: Lead[]): void {
    fs.writeFileSync(`${base}_enriched.json`, JSON.stringify(enriched, null, 2));
    const rows = enriched.map((lead) =>
        CSV_COLUMNS.map((column) => csvCell(column === "event_count" ? (lead.events ?? []).length : lead[column])).join(",")
    );
    fs.writeFileSync(`${base}_enriched.csv`, [CSV_COLUMNS.join(","), ...rows].join("\n") + "\n", "utf8");
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const input = args.find((arg) => !arg.startsWith("--")) ?? path.join(OUTPUT_DIR, "token2049_leads_clean.json");
    const limitArg = args.find((arg) => arg.startsWith("--limit="))?.split("=")[1];
    const limit = limitArg ? parseInt(limitArg, 10) : Infinity;
    const targetArg = args.find((arg) => arg.startsWith("--target="))?.split("=")[1];
    const target = targetArg ? parseInt(targetArg, 10) : Infinity;
    const batchSize = parseInt(args.find((arg) => arg.startsWith("--batch="))?.split("=")[1] ?? "15", 10);
    if (Number.isNaN(limit) || limit < 1 || Number.isNaN(batchSize) || batchSize < 1) throw new Error("--limit and --batch must be positive numbers.");

    const config = await readConfig();
    const base = input.replace(/\.json$/, "");
    const leads: Lead[] = JSON.parse(fs.readFileSync(input, "utf8"));
    const enriched: Lead[] = fs.existsSync(`${base}_enriched.json`) ? JSON.parse(fs.readFileSync(`${base}_enriched.json`, "utf8")) : [];
    const done = new Set(enriched.map((lead) => lead.luma_user_id));
    const cache: Cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) : { x: {}, pages: {} };

    // A Luma session key starts with its user id: "usr-xxx.yyy".
    const ownIds = new Set(
        Object.entries({ ...config, ...process.env })
            .filter(([key, value]) => key.startsWith("COOKIES_ACCOUNT_") && value)
            .map(([, value]) => normalizeLumaCookie(value as string)?.match(/luma\.auth-session-key=(usr-[A-Za-z0-9]+)\./)?.[1])
            .filter(Boolean)
    );

    const queue = leads
        .filter((lead) => !done.has(lead.luma_user_id) && !ownIds.has(lead.luma_user_id))
        .sort((a, b) => {
            const [tierA, eventsA] = priority(a);
            const [tierB, eventsB] = priority(b);
            return tierB - tierA || eventsB - eventsA;
        })
        .slice(0, Math.max(0, Math.min(limit, target - enriched.length)));
    console.log(`${leads.length} leads, ${done.size} already enriched, ${ownIds.size} own accounts skipped, enriching ${queue.length} now.`);

    // Claude reads up to CLAUDE_PARALLEL batches while the evidence of the next one is gathered.
    const CLAUDE_PARALLEL = 2;
    const pending: Promise<void>[] = [];
    for (let start = 0; start < queue.length; start += batchSize) {
        const batch = queue.slice(start, start + batchSize);
        const batchNumber = start / batchSize + 1;
        console.log(`  Batch ${batchNumber}/${Math.ceil(queue.length / batchSize)}: gathering evidence (X gap ${xDelay}ms)...`);
        await waitForNetwork();
        const evidence: Record<string, unknown>[] = [];
        for (const lead of batch) evidence.push(await gatherEvidence(lead, cache));
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
        if (pending.length >= CLAUDE_PARALLEL) await pending.shift();
        pending.push(enrichBatch(evidence, config).then((results) => saveBatch(batch, evidence, results)));
    }
    await Promise.all(pending);
    console.log(`Done. Wrote ${path.relative(process.cwd(), base)}_enriched.{json,csv}`);

    function saveBatch(batch: Lead[], evidence: Record<string, unknown>[], results: Map<string, Enrichment>): void {
        for (const [i, lead] of batch.entries()) {
            const result = results.get(lead.luma_user_id);
            if (!result) continue; // Left for the next run.
            const proof = evidence[i];
            enriched.push({
                ...lead,
                ...result,
                x_bio: proof.x_bio ?? null,
                x_location: proof.x_location ?? null,
                x_followers: proof.x_followers ?? null,
                enriched_at: new Date().toISOString(),
            });
        }
        writeOutputs(base, enriched);
        console.log(`    ${results.size}/${batch.length} enriched, ${enriched.length} total.`);
    }
}

main().catch((error) => {
    console.error("\x1b[31mEnrichment failed:\x1b[0m", error.message ?? error);
    process.exit(1);
});
