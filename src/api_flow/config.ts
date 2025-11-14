import * as fs from "fs/promises";
import * as path from "path";
import * as dotenv from "dotenv";

// Load environment variables from root .env file
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const PROFILE_FILE = path.resolve(__dirname, "../../profile.txt"); // Resolve path relative to compiled JS

// Restored readConfig function
export async function readConfig(): Promise<Record<string, string>> {
    const configPath = path.resolve(__dirname, "../../config.txt");
    try {
        const configContent = await fs.readFile(configPath, "utf-8");
        const config: Record<string, string> = {};

        configContent.split("\n").forEach((line) => {
            const [key, value] = line.split("=").map((s) => s.trim());
            if (key && value) {
                config[key] = value;
            }
        });

        // Set default browser if not specified
        if (!config["BROWSER"]) {
            config["BROWSER"] = "chrome";
        }

        console.log("Config loaded from config.txt:", config);
        return config;
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            console.error('\x1b[31mPlease make sure you have a config.txt in the root directory. You can use config_template.txt, modify it, and rename it to config.txt.\x1b[0m');
        } else {
            console.error(
                `\x1b[31mCould not read config file ${configPath}:\x1b[0m`,
                error
            );
        }
        return {};
    }
}

export async function readProfile(): Promise<Record<string, string>> {
    try {
        const data = await fs.readFile(PROFILE_FILE, "utf-8");
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
            `\x1b[33mCould not read profile file ${PROFILE_FILE}:\x1b[0m`,
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
