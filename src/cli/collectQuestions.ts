// Collects the registration questions of every event on EVENT_CALENDAR_URL, groups similar
// questions into profile fields with Claude, and reports which fields each profile is missing.
//
// Usage: npx ts-node src/cli/collectQuestions.ts [--refresh]
//   --refresh  re-download event details instead of using the cache in questions/event_details.json
//
// Output (in questions/):
//   missing_fields.md   fields to add to each profile, most frequently asked first
//   fields.json         the grouped fields with their questions
//   event_details.json  cached questions per event
import * as fs from "fs/promises";
import path from "path";
import { readConfig, readProfile } from "../api_flow/config";
import { fetchEventDetails } from "../api_flow/api_helper";
import { callClaude } from "../api_flow/llm";
import { fetchAllEventEntriesFromCalendarApi, getCalendarApiId } from "../api_flow/lumaRunner";

const OUT_DIR = path.resolve(__dirname, "../../questions");
const PROFILES_DIR = path.resolve(__dirname, "../../profiles");
const DETAILS_CACHE = path.join(OUT_DIR, "event_details.json");
const FETCH_CONCURRENCY = 3;
// Accepted automatically by the bot, no profile data needed
const AUTO_ANSWERED_TYPES = ["terms", "agree-check"];
const EMPTY_VALUES = ["", "n/a", "na", "-"];

interface EventQuestions {
    eventName: string;
    questions: { label: string; question_type: string; required: boolean; options?: string[] }[];
    requirements: Record<string, string | null>; // phone / eth / solana requirements set on the event
}

interface UniqueQuestion {
    label: string;
    type: string;
    options: string[];
    eventCount: number;
    requiredCount: number;
}

interface GroupedField {
    name: string;
    description: string;
    category: "profile" | "event-specific";
    questions: number[];
    coverage: Record<string, "covered" | "missing">;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeLabel(label: string): string {
    return label.toLowerCase().replace(/\s+/g, " ").replace(/[\s*:?.!]+$/, "").trim();
}

async function loadEventQuestions(config: Record<string, string>, refresh: boolean): Promise<Record<string, EventQuestions>> {
    let cache: Record<string, EventQuestions> = {};
    if (!refresh) {
        try {
            cache = JSON.parse(await fs.readFile(DETAILS_CACHE, "utf-8"));
        } catch {
            // No cache yet
        }
    }

    const calendarApiId = await getCalendarApiId(config["EVENT_CALENDAR_URL"], null);
    if (!calendarApiId) throw new Error(`Could not get calendar id from ${config["EVENT_CALENDAR_URL"]}`);
    const entries = (await fetchAllEventEntriesFromCalendarApi(calendarApiId, null)).filter(
        (entry) => entry.platform !== "external" && entry.event.api_id
    );
    const toFetch = entries.filter((entry) => !cache[entry.event.api_id]);
    console.log(`\n${entries.length} Luma events on the calendar, ${toFetch.length} to download (${entries.length - toFetch.length} cached).`);

    let done = 0;
    const worker = async () => {
        while (toFetch.length > 0) {
            const entry = toFetch.shift()!;
            const details: any = await fetchEventDetails(entry.event.api_id);
            if (details) {
                cache[entry.event.api_id] = {
                    eventName: entry.event.name,
                    questions: (details.registration_questions || []).map((q: any) => ({
                        label: q.label,
                        question_type: q.question_type,
                        required: !!q.required,
                        options: q.options,
                    })),
                    requirements: {
                        phone_number: details.phone_number_requirement ?? null,
                        eth_address: details.eth_address_requirement ?? null,
                        solana_address: details.solana_address_requirement ?? null,
                    },
                };
            }
            done++;
            if (done % 25 === 0) console.log(`  Downloaded ${done} events...`);
            await sleep(500 + Math.random() * 500);
        }
    };
    await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));

    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.writeFile(DETAILS_CACHE, JSON.stringify(cache, null, 2));
    // Only report on events still on the calendar
    return Object.fromEntries(entries.filter((e) => cache[e.event.api_id]).map((e) => [e.event.api_id, cache[e.event.api_id]]));
}

function aggregateQuestions(events: Record<string, EventQuestions>): UniqueQuestion[] {
    const unique = new Map<string, UniqueQuestion>();
    for (const event of Object.values(events)) {
        for (const q of event.questions) {
            if (AUTO_ANSWERED_TYPES.includes(q.question_type)) continue;
            const key = `${q.question_type}|${normalizeLabel(q.label)}`;
            const existing = unique.get(key) || {
                label: q.label.trim(),
                type: q.question_type,
                options: [],
                eventCount: 0,
                requiredCount: 0,
            };
            existing.eventCount++;
            if (q.required) existing.requiredCount++;
            for (const option of q.options || []) {
                if (!existing.options.includes(option)) existing.options.push(option);
            }
            unique.set(key, existing);
        }
    }
    return [...unique.values()].sort((a, b) => b.eventCount - a.eventCount);
}

function countRequirements(events: Record<string, EventQuestions>): Record<string, Record<string, number>> {
    const counts: Record<string, Record<string, number>> = {};
    for (const event of Object.values(events)) {
        for (const [field, value] of Object.entries(event.requirements)) {
            counts[field] ??= {};
            counts[field][String(value)] = (counts[field][String(value)] || 0) + 1;
        }
    }
    return counts;
}

// Question types that always ask for the same thing, so they need no LLM grouping
const TYPED_FIELDS: Record<string, string> = {
    company: "Company",
    linkedin: "LinkedIn",
    twitter: "Twitter",
    telegram: "Telegram",
    "phone-number": "Phone",
    instagram: "Instagram",
    youtube: "YouTube",
    github: "GitHub",
    tiktok: "TikTok",
};
const LABEL_BATCH_SIZE = 60;
const LLM_CONCURRENCY = 4;

function extractJson(text: string): any {
    return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}

async function runLimited<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
    const results: T[] = new Array(tasks.length);
    let next = 0;
    const worker = async () => {
        while (next < tasks.length) {
            const index = next++;
            results[index] = await tasks[index]();
        }
    };
    await Promise.all(Array.from({ length: limit }, worker));
    return results;
}

// Step 1: give each free-form question a short field name, in parallel batches.
async function labelQuestions(
    questions: UniqueQuestion[],
    indexes: number[],
    vocabulary: string[],
    config: Record<string, string>
): Promise<Record<number, string>> {
    const batches: number[][] = [];
    for (let i = 0; i < indexes.length; i += LABEL_BATCH_SIZE) batches.push(indexes.slice(i, i + LABEL_BATCH_SIZE));

    const results = await runLimited(
        batches.map((batch, batchIndex) => async () => {
            const list = batch
                .map((i) => {
                    const q = questions[i];
                    const options = q.options.length > 0 ? ` | options: ${q.options.slice(0, 8).join(" / ")}` : "";
                    return `#${i} [${q.type}] ${q.label.replace(/\s+/g, " ").slice(0, 300)}${options}`;
                })
                .join("\n");
            const prompt = `Give each event registration question below a short profile field name (2-4 words, Title Case) describing the information it asks for. Questions asking for the same information must get the same name. Prefer these names when they fit: ${vocabulary.join(", ")}. Only questions tied to that particular event or its host get a name starting with "Event: ": who invited you, how you heard about it, session/track/meal choice, arrival time, promo/access/referral codes, usage of or interest in the host's own products, whether you follow the host's socials. Everything describing the person or their company that could be reused across events (role, company stage/type, goals, what they're looking for, investor details, industry, age, gender, wallet addresses, other handles, education, region) gets a normal name without the prefix.

Respond with ONLY a JSON object mapping question number to name, e.g. {"12":"Job Title","13":"Event: How Heard"}

${list}`;
            for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                    const { text } = await callClaude(prompt, config, undefined, 5 * 60 * 1000);
                    console.log(`  Labelled batch ${batchIndex + 1}/${batches.length}`);
                    return extractJson(text) as Record<string, string>;
                } catch (error: any) {
                    console.warn(`  Batch ${batchIndex + 1} attempt ${attempt} failed: ${error.message}`);
                }
            }
            return {} as Record<string, string>;
        }),
        LLM_CONCURRENCY
    );

    const labels: Record<number, string> = {};
    for (const result of results) {
        for (const [index, name] of Object.entries(result)) labels[Number(index)] = String(name).trim();
    }
    return labels;
}

async function groupWithClaude(
    questions: UniqueQuestion[],
    profiles: Record<string, Record<string, string>>,
    config: Record<string, string>
): Promise<GroupedField[]> {
    const labels: Record<number, string> = {};
    const freeForm: number[] = [];
    questions.forEach((q, i) => (TYPED_FIELDS[q.type] ? (labels[i] = TYPED_FIELDS[q.type]) : freeForm.push(i)));

    const vocabulary = [
        ...new Set([...Object.values(profiles).flatMap((p) => Object.keys(p)), ...Object.values(TYPED_FIELDS), "Job Title", "Website", "Email", "Phone"]),
    ];
    console.log(`\n${questions.length - freeForm.length} typed questions mapped directly. Asking Claude to label ${freeForm.length} free-form questions...`);
    Object.assign(labels, await labelQuestions(questions, freeForm, vocabulary, config));
    questions.forEach((q, i) => (labels[i] ??= q.label.replace(/\s+/g, " ").slice(0, 60)));

    // Step 2: merge near-duplicate names and check profile coverage.
    const byName = new Map<string, number[]>();
    Object.entries(labels).forEach(([i, name]) => byName.set(name, [...(byName.get(name) || []), Number(i)]));
    const names = [...byName.entries()]
        .map(([name, idx]) => ({ name, idx, events: idx.reduce((sum, i) => sum + questions[i].eventCount, 0) }))
        .sort((a, b) => b.events - a.events);

    const nameList = names
        .map((n) => {
            const example = questions[n.idx[0]];
            const options = example.options.length > 0 ? ` | options: ${example.options.slice(0, 6).join(" / ")}` : "";
            return `- ${n.name} (${n.events} events) e.g. "${example.label.replace(/\s+/g, " ").slice(0, 120)}"${options}`;
        })
        .join("\n");
    const profileList = Object.entries(profiles)
        .map(([id, profile]) => `Profile "${id}":\n${Object.entries(profile).map(([k, v]) => `  ${k}: ${v}`).join("\n")}`)
        .join("\n\n");
    const prompt = `Below are profile field names derived from event registration questions, and the user profiles a bot answers them from. Merge names that mean the same thing into one field.

For each resulting field give:
- "name": the field name (reuse an existing profile key when it matches)
- "from": every input name merged into it (each input name must appear in exactly one field)
- "category": "event-specific" only if the input names start with "Event: " (questions about a particular event or its host), else "profile"
- "description": one short sentence on what to put there, listing the common answer options if it's a choice
- "coverage": for each profile, "covered" if it has a value that answers the field ("none" counts as an answer, e.g. for allergies; "n/a" or empty does not), else "missing"

Respond with ONLY a JSON object: {"fields":[{"name":"...","from":["..."],"category":"profile","description":"...","coverage":{${Object.keys(profiles).map((id) => `"${id}":"missing"`).join(",")}}}]}

Field names:
${nameList}

${profileList}`;

    console.log(`Merging ${names.length} field names and checking profile coverage...`);
    const { text } = await callClaude(prompt, config, undefined, 10 * 60 * 1000);
    const merged: { name: string; from: string[]; category: GroupedField["category"]; description: string; coverage: GroupedField["coverage"] }[] =
        extractJson(text).fields;

    const fields: GroupedField[] = [];
    const used = new Set<string>();
    for (const field of merged) {
        const idx = (field.from || []).filter((n) => byName.has(n) && !used.has(n)).flatMap((n) => (used.add(n), byName.get(n)!));
        if (idx.length > 0) fields.push({ name: field.name, description: field.description, category: field.category, questions: idx, coverage: field.coverage || {} });
    }
    // Anything Claude left out stays as its own field so nothing is silently dropped
    for (const { name, idx } of names) {
        if (used.has(name)) continue;
        fields.push({
            name: name.replace(/^Event: /, ""),
            description: "Not merged by Claude.",
            category: name.startsWith("Event: ") ? "event-specific" : "profile",
            questions: idx,
            coverage: Object.fromEntries(Object.keys(profiles).map((id) => [id, "missing"])),
        });
    }
    return fields;
}

function isFilled(value: string | undefined): boolean {
    return !!value && !EMPTY_VALUES.includes(value.trim().toLowerCase());
}

function buildReport(
    fields: GroupedField[],
    questions: UniqueQuestion[],
    profiles: Record<string, Record<string, string>>,
    requirements: Record<string, Record<string, number>>,
    eventCount: number
): string {
    const eventsFor = (field: GroupedField) => field.questions.reduce((sum, i) => sum + (questions[i]?.eventCount || 0), 0);
    const sorted = [...fields].sort((a, b) => eventsFor(b) - eventsFor(a));
    const profileFields = sorted.filter((f) => f.category === "profile");
    const lines: string[] = [
        `# Profile fields from ${eventCount} events`,
        "",
        `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC. "Events" counts how many events ask it (an event can ask twice).`,
        "Terms and consent checkboxes are left out; the bot accepts them automatically.",
        "",
        "## Event-level requirements",
        "",
        "Name and email are always sent. These are set per event and filled from the profile:",
        "",
    ];
    const requirementKeys: Record<string, string[]> = {
        phone_number: ["Phone", "WhatsApp"],
        eth_address: ["ETH Address"],
        solana_address: ["Solana Address"],
    };
    for (const [field, counts] of Object.entries(requirements)) {
        const summary = Object.entries(counts).map(([value, n]) => `${value}: ${n}`).join(", ");
        const status = Object.entries(profiles)
            .map(([id, p]) => `${id} ${requirementKeys[field].some((k) => isFilled(p[k])) ? "has it" : "missing"}`)
            .join(", ");
        lines.push(`- **${field}** (${summary}) → profile key \`${requirementKeys[field][0]}\` (${status})`);
    }

    for (const id of Object.keys(profiles)) {
        const missing = profileFields.filter((f) => f.coverage[id] !== "covered");
        lines.push("", `## Missing in profiles/${id}.txt (${missing.length})`, "");
        if (missing.length === 0) {
            lines.push("Nothing missing.");
            continue;
        }
        lines.push("| Field | Events | What to put | Example questions |", "| --- | --- | --- | --- |");
        for (const field of missing) {
            const examples = field.questions
                .slice(0, 3)
                .map((i) => questions[i]?.label.replace(/\|/g, "/").replace(/\s+/g, " ").slice(0, 80))
                .join("; ");
            lines.push(`| ${field.name} | ${eventsFor(field)} | ${field.description.replace(/\|/g, "/")} | ${examples} |`);
        }
        lines.push("", "Paste into the profile and fill in:", "", "```", ...missing.map((f) => `${f.name}: `), "```");
    }

    const eventSpecific = sorted.filter((f) => f.category === "event-specific");
    lines.push("", `## Event-specific questions (${eventSpecific.length})`, "", "Claude answers these per event; no profile entry needed, but you can add a default.", "");
    for (const field of eventSpecific) {
        lines.push(`- **${field.name}** (${eventsFor(field)} events): ${field.description}`);
    }
    return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
    const refresh = process.argv.includes("--refresh");
    const config = await readConfig();
    if (!config["EVENT_CALENDAR_URL"]) throw new Error("EVENT_CALENDAR_URL is not set.");

    const profileIds = (await fs.readdir(PROFILES_DIR)).filter((f) => f.endsWith(".txt")).map((f) => f.slice(0, -4));
    const profiles: Record<string, Record<string, string>> = {};
    for (const id of profileIds) {
        profiles[id] = await readProfile(path.join(PROFILES_DIR, `${id}.txt`));
    }

    const events = await loadEventQuestions(config, refresh);
    const questions = aggregateQuestions(events);
    const requirements = countRequirements(events);
    console.log(`${questions.length} unique questions across ${Object.keys(events).length} events.`);

    const fields = await groupWithClaude(questions, profiles, config);
    await fs.writeFile(
        path.join(OUT_DIR, "fields.json"),
        JSON.stringify(fields.map((f) => ({ ...f, questions: f.questions.map((i) => questions[i]) })), null, 2)
    );
    const reportPath = path.join(OUT_DIR, "missing_fields.md");
    await fs.writeFile(reportPath, buildReport(fields, questions, profiles, requirements, Object.keys(events).length));
    console.log(`\nReport written to ${path.relative(process.cwd(), reportPath)}`);
}

main().catch((error) => {
    console.error("\x1b[31mFailed:\x1b[0m", error);
    process.exit(1);
});
