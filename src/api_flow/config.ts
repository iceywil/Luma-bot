import * as fs from "fs/promises";
import * as path from "path";
import * as dotenv from "dotenv";

// Load environment variables from root .env file
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const PROFILE_FILE = path.resolve(__dirname, "../../profile.txt"); // Resolve path relative to compiled JS

// Settings that can also be provided as environment variables (they override config.txt).
// Useful on a server, where config.txt is not deployed.
const ENV_CONFIG_KEYS = [
    "EVENT_CALENDAR_URL",
    "CLAUDE_MODEL",
    "LLM_BATCH_CONTEXT",
    "LLM_BATCH_PROMPT_TEMPLATE",
    "LLM_TICKET_CONTEXT",
    "LLM_TICKET_PROMPT_TEMPLATE",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CLI_PATH",
    "MAX_REGISTRATIONS_PER_RUN",
    "TIMEZONE",
    "DRY_RUN",
    "BROWSER",
    "SERVER_MODE",
    "HEADLESS",
    "MAX_EVENTS",
    "CAPTCHA_WAIT_SECONDS",
    "BROWSER_MODE",
    "MANUAL_SUBMIT",
    "MANUAL_SUBMIT_WAIT_SECONDS",
    "AUTO_CAPTCHA",
    "EVENT_TIMEOUT_SECONDS",
    "MAX_RUN_MINUTES",
];

function maskSecrets(config: Record<string, string>): Record<string, string> {
    const masked: Record<string, string> = {};
    for (const [key, value] of Object.entries(config)) {
        masked[key] = /KEY|TOKEN|SECRET|COOKIE/i.test(key) ? "***" : value;
    }
    return masked;
}

export async function readConfig(): Promise<Record<string, string>> {
    const configPath = path.resolve(__dirname, "../../config.txt");
    const config: Record<string, string> = {};
    try {
        const configContent = await fs.readFile(configPath, "utf-8");
        configContent.split("\n").forEach((line) => {
            if (line.trim().startsWith("#")) return;
            const separatorIndex = line.indexOf("=");
            if (separatorIndex === -1) return;
            const key = line.slice(0, separatorIndex).trim();
            const value = line.slice(separatorIndex + 1).trim();
            if (key && value) {
                config[key] = value;
            }
        });
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            console.warn('\x1b[33mNo config.txt found, using environment variables only. Locally, you can use config_template.txt, modify it, and rename it to config.txt.\x1b[0m');
        } else {
            console.error(
                `\x1b[31mCould not read config file ${configPath}:\x1b[0m`,
                error
            );
        }
    }

    for (const key of ENV_CONFIG_KEYS) {
        if (process.env[key]) {
            config[key] = process.env[key] as string;
        }
    }

    // Set default browser if not specified
    if (!config["BROWSER"]) {
        config["BROWSER"] = "chrome";
    }

    console.log("Config loaded:", maskSecrets(config));
    return config;
}

export async function readProfile(profileFile: string = PROFILE_FILE): Promise<Record<string, string>> {
    try {
        const data = await fs.readFile(profileFile, "utf-8");
        const lines = data.split("\n");
        const profile: Record<string, string> = {};
        for (const line of lines) {
            if (line.includes(":")) {
                const [key, ...valueParts] = line.split(":");
                profile[key.trim()] = valueParts.join(":").trim();
            }
        }
        console.log("Profile loaded:", profile);
        return profile;
    } catch (error) {
        console.warn(
            `\x1b[33mCould not read profile file ${profileFile}:\x1b[0m`,
            error
        );
        return {};
    }
}

// --- Update Profile File Directly (No LLM) ---
export async function updateProfile(
    newData: Record<string, string | string[] | null>
    // config parameter is no longer needed
): Promise<void> {
    console.log(`Attempting to directly update profile file: ${PROFILE_FILE}`);

    try {
        // 1. Read existing profile data
        const existingProfileData = await readProfile(); // Use existing readProfile function
        console.log("Read existing profile data for merging.");

        // 2. Merge newData into existingProfileData
        let profileChanged = false;
        for (const key in newData) {
            if (Object.prototype.hasOwnProperty.call(newData, key)) {
                const newValue = newData[key];
                if (newValue !== null) {
                    // Only process non-null updates
                    const newValueString = Array.isArray(newValue)
                        ? newValue.join(", ")
                        : String(newValue);
                    // Simple overwrite/add - LLM's semantic merge logic is removed
                    if (existingProfileData[key] !== newValueString) {
                        console.log(
                            `  Updating profile key "${key}": "${existingProfileData[key]}" -> "${newValueString}"`
                        );
                        existingProfileData[key] = newValueString;
                        profileChanged = true;
                    }
                } else {
                    // Optional: Handle null values if needed (e.g., delete key?)
                    // console.log(`  Skipping null value for key "${key}".`);
                }
            }
        }

        // 3. Write back only if changes were made
        if (profileChanged) {
            console.log(
                "Profile data changed, writing updates back to file..."
            );
            const updatedProfileLines: string[] = [];
            for (const key in existingProfileData) {
                if (
                    Object.prototype.hasOwnProperty.call(
                        existingProfileData,
                        key
                    )
                ) {
                    updatedProfileLines.push(
                        `${key}: ${existingProfileData[key]}`
                    );
                }
            }
            const updatedProfileText = updatedProfileLines.join("\n");

            await fs.writeFile(PROFILE_FILE, updatedProfileText, "utf8");
            console.log(`Successfully updated profile file ${PROFILE_FILE}.`);
        } else {
            console.log(
                "No changes detected in profile data. File not updated."
            );
        }
    } catch (error) {
        console.error(
            "\x1b[31mError during direct profile update or file write:\x1b[0m",
            error
        );
    }
}
