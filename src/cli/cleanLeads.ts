// Removes the leads with nothing to go on: Luma's placeholder avatar, no bio and no social or
// website link. Writes <file>_clean.json next to the input and leaves the input untouched.
//
// Usage: npm run clean-leads -- output/token2049_leads.json [more files...]
import * as fs from "fs";

const DEFAULT_AVATAR = "https://cdn.lu.ma/avatars-default/";
const LINK_FIELDS = ["twitter", "linkedin", "instagram", "tiktok", "youtube", "website"];

function hasSomething(lead: Record<string, any>): boolean {
    const hasAvatar = Boolean(lead.avatar_url) && !String(lead.avatar_url).startsWith(DEFAULT_AVATAR);
    const hasBio = Boolean(lead.bio?.trim());
    return hasAvatar || hasBio || LINK_FIELDS.some((field) => Boolean(lead[field]));
}

const files = process.argv.slice(2);
if (files.length === 0) {
    console.error("Usage: npm run clean-leads -- <leads.json> [more files...]");
    process.exit(1);
}
for (const file of files) {
    const leads: Record<string, any>[] = JSON.parse(fs.readFileSync(file, "utf8"));
    const kept = leads.filter(hasSomething);
    const out = file.replace(/\.json$/, "") + "_clean.json";
    fs.writeFileSync(out, JSON.stringify(kept, null, 2));
    console.log(`${file}: kept ${kept.length}/${leads.length}, removed ${leads.length - kept.length} -> ${out}`);
}
