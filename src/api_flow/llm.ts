import * as dotenv from 'dotenv';

// Load environment variables from root .env file
dotenv.config({ path: require('path').resolve(__dirname, '../.env') });

// --- Interfaces ---
export interface LLMFieldRequest {
  identifier: string; // Label or name used to identify the field (cleaned of *)
  type: 'text' | 'select' | 'checkbox' | 'multiselect';
  options?: string[];
  locator: import('playwright').Locator; // Reference to the Playwright locator
  isMandatory: boolean; // Flag indicating if field is mandatory
}

// --- Claude helper ---
// Runs the local Claude Code CLI in headless mode (`claude -p`), which authenticates with your
// Claude Code OAuth login (run `claude` once and log in), or with CLAUDE_CODE_OAUTH_TOKEN from
// config.txt (generate one with `claude setup-token`).
const DEFAULT_CLAUDE_MODEL = 'sonnet';

export interface ClaudeResult {
    text: string;
    stopReason?: string;
}

export function getClaudeModel(config: Record<string, string>): string {
    return config.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL;
}

export function callClaude(
    prompt: string,
    config: Record<string, string>,
    systemPrompt: string = 'You are a precise assistant. Follow the output format instructions exactly.',
    timeoutMs: number = 120000
): Promise<ClaudeResult> {
    const { spawn } = require('child_process') as typeof import('child_process');
    const env = { ...process.env };
    if (config.CLAUDE_CODE_OAUTH_TOKEN) {
        env.CLAUDE_CODE_OAUTH_TOKEN = config.CLAUDE_CODE_OAUTH_TOKEN;
    }
    const args = [
        '-p',
        '--output-format', 'json',
        '--model', getClaudeModel(config),
        '--system-prompt', systemPrompt,
        '--tools', '',
        '--setting-sources', '',
        '--strict-mcp-config',
        '--no-session-persistence',
    ];

    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
        const child = spawn(config.CLAUDE_CLI_PATH || 'claude', args, {
            env,
            cwd: require('os').tmpdir(),
            timeout: timeoutMs,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('error', (err) => reject(new Error(`Could not run the claude CLI (is Claude Code installed?): ${err.message}`)));
        child.on('close', (code) => {
            let data: any;
            try {
                data = JSON.parse(stdout);
            } catch {
                return reject(new Error(`claude CLI exited with code ${code}: ${(stderr || stdout).substring(0, 500)}`));
            }
            if (data.is_error || typeof data.result !== 'string') {
                return reject(new Error(`Claude returned an error: ${String(data.result ?? JSON.stringify(data)).substring(0, 500)}`));
            }
            console.log(`  Claude (${getClaudeModel(config)}) answered in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
            resolve({ text: data.result, stopReason: data.stop_reason });
        });
        child.stdin.end(prompt);
    });
}

// Function to call LLM to choose the best free ticket
export async function chooseBestFreeTicketLLM(
    ticketOptions: string[], 
    profileData: Record<string, string>,
    config: Record<string, string>
): Promise<string | null> { // Returns the name of the chosen ticket or null
    console.log(`\n--- Choosing Best Free Ticket LLM Call (Claude) ---`);
    if (ticketOptions.length === 0) {
        console.log("No free ticket options provided.");
        return null;
    }

    const profileString = JSON.stringify(profileData);
    const optionsString = ticketOptions.join(", ");
    
    // Read context/prompt from config object
    const context: string = config.LLM_TICKET_CONTEXT 
        || "Select the best ticket."; // Minimal fallback
    const promptTemplate: string = config.LLM_TICKET_PROMPT_TEMPLATE 
        || "Profile: {profileString}, Options: [{optionsString}], Context: {context}. Choose one option name or NULL."; 

    // Replace placeholders
    const systemMessage = promptTemplate
        .replace('{profileString}', profileString)
        .replace('{optionsString}', optionsString)
        .replace('{context}', context);

    console.log(`Profile Data (for context): ${profileString}`);
    console.log(`Free Ticket Options: [${optionsString}]`);
    console.log(`Sending prompt to Claude (${getClaudeModel(config)} for ticket choice)...`);

    try {
        const { text } = await callClaude(systemMessage, config);
        let chosenTicket = text.trim().replace(/^["']|["']$/g, '');
        // Ticket names carry a badge after a zero-width space ("Standard​Require Approval"), which the
        // answer often leaves out: match on the name part too
        const namePart = (option: string) => option.split('​')[0].trim().toLowerCase();
        if (chosenTicket && !ticketOptions.includes(chosenTicket)) {
            chosenTicket = ticketOptions.find((option) => namePart(option) === namePart(chosenTicket)) ?? chosenTicket;
        }
        if (chosenTicket && chosenTicket.toUpperCase() !== 'NULL' && ticketOptions.includes(chosenTicket)) {
             console.log(`Claude chose ticket: "${chosenTicket}"`);
             return chosenTicket;
        } else {
            console.log('Claude did not provide a valid ticket choice or chose NULL.', chosenTicket);
            return null;
        }
    } catch (error) {
        console.error("\x1b[31mError during Claude call (Ticket Choice):\x1b[0m", error);
        return null;
    }
}

// Function to call LLM with a batch of fields
export async function callLLMBatched(
    fields: LLMFieldRequest[], 
    profileData: Record<string, string>,
    config: Record<string, string>
): Promise<Record<string, string | string[] | null>> {
    console.log(`\n--- Batch LLM Call (Claude) ---`); 
    if (fields.length === 0) {
        console.log("No fields require LLM input.");
        return {};
    }

    // --- Prepare Prompt (as before, but this will be the user message) ---
    const profileString = JSON.stringify(profileData);
    const fieldDescriptions = fields.map(f => {
        let desc = `Field: "${f.identifier}"${f.isMandatory ? ' (Mandatory *)' : ''} (Type: ${f.type})`;
        if (f.options && f.options.length > 0) {
            desc += `, Options: [${f.options.join(', ')}]`;
        }
        if (f.type === 'multiselect') {
            desc += ` (Allow multiple selections)`;
        }
        return desc;
    }).join('\n');
    const context: string = config.LLM_BATCH_CONTEXT || "Fill form fields for event registration.";
    const promptTemplate: string = config.LLM_BATCH_PROMPT_TEMPLATE || 
        "Given user profile {profileString}, form fields {fieldDescriptions}, and context {context}. Provide JSON response. Keys MUST be exact field identifiers. " +
        "For 'select' type, choose ONE value STRICTLY from its Options list. If no option perfectly matches, choose the MOST SIMILAR option from the list. " +
        "For 'multiselect' type, provide a JSON array containing one or more values STRICTLY from its Options list." +
        "For mandatory fields (*), ALWAYS provide a suitable value (e.g., Yes/No for checkboxes, a selection for selects, text based on profile). " +
        "For optional fields where the profile doesn't provide a clear answer, provide a reasonable default like 'N/A', choose the first option if applicable, or make an educated guess based on the profile. " +
        // --- INTENSE FINAL INSTRUCTIONS ---
        "*** MANDATORY RULES FOR RESPONSE FORMAT ***" + 
        "1. KEYS MUST BE EXACT: Use the ***EXACT*** field identifiers provided in the fieldDescriptions list as the keys in your JSON response. DO NOT change phrasing, case, punctuation, or spacing. COPY THE IDENTIFIER PRECISELY. " +
        "2. NO NULL VALUES: Your response must NOT contain `null` or `NULL` for any key. " +
        "3. USE PROFILE: If the user profile {profileString} contains a value for a field, use it. " +
        // Emphasize fallback for MANDATORY text fields
        "4. MANDATORY FIELD FALLBACK: For fields marked mandatory (*), you MUST provide a value. If the profile lacks info AND the field is type 'text', use the exact string \"n/a\". DO NOT USE NULL. " + 
        "5. OPTIONAL FIELD FALLBACK: For optional fields without profile info, use \"n/a\" for text, or the first option/[] for select/multiselect if applicable. " +
        "6. SELECT/MULTISELECT: For 'select'/'multiselect', choose STRICTLY from the Options list. " +
        "7. ONLY JSON: Your response MUST contain ONLY the JSON object, starting with { and ending with }. No text, explanation, or comments before or after. " +
        "Example Format: { \"Exact Identifier From Request\": \"ValueOrArrayOrNA\", \"Another Exact Identifier\": \"Another Value\" }";
    const prompt = promptTemplate
        .replace('{profileString}', profileString)
        .replace('{fieldDescriptions}', fieldDescriptions)
        .replace('{context}', context)
        // Add a stricter final instruction
        + "\n\nCRITICAL: Your response MUST contain ONLY the JSON object requested, starting with { and ending with }. "
        + "Do NOT include any explanations, comments, apologies, reasoning, or any other text before or after the JSON object. "
        + "Use the EXACT field identifiers provided in the request as the keys in the JSON.";

    // --- Retry Logic --- 
    const maxRetries = 3;
    let currentAttempt = 0;
    let baseDelay = 2000; // Start with 2 seconds

    console.log(`Sending prompt to Claude (${getClaudeModel(config)})... (Max Retries: ${maxRetries})`);

    while (currentAttempt < maxRetries) {
        currentAttempt++;
        console.log(`  Attempt ${currentAttempt}/${maxRetries}...`);
        try {
            const { text: rawContentString, stopReason } = await callClaude(prompt, config, undefined, 90000);

            {
                if (stopReason === 'max_tokens') {
                    console.warn(`Claude response may have been truncated due to length (Attempt ${currentAttempt}).`);
                }

                if (!rawContentString) {
                     console.error(`\x1b[31mClaude returned an empty response (Attempt ${currentAttempt}).\x1b[0m`);
                     // Let it retry
                 } else {
                     console.log("Claude Response Content (Raw):", rawContentString);
                     let jsonString = null;
                     const lastBraceIndex = rawContentString.lastIndexOf('{');
                     if (lastBraceIndex !== -1) {
                         const potentialJson = rawContentString.substring(lastBraceIndex);
                         console.log("Attempting to parse JSON from last '{':", potentialJson);
                         if (potentialJson.trim().endsWith('}')) {
                              jsonString = potentialJson;
                         } else {
                              console.warn("Substring from last '{' did not end with '}'. Trying regex as fallback.");
                              const jsonMatch = rawContentString.match(/\{.*\}/s); 
                              if (jsonMatch && jsonMatch[0]) {
                                  jsonString = jsonMatch[0];
                                  console.log("Extracted JSON string using regex fallback:", jsonString);
                              } 
                         }
                     } else {
                         console.warn("Could not find any '{' in the Claude response.");
                     }
                     if (!jsonString) {
                         console.error(`\x1b[31mCould not find or extract JSON content in Claude response (Attempt ${currentAttempt}).\x1b[0m`);
                         // Let it retry
                     } else {
                         try {
                             // Add replacement logic before parsing
                             const correctedJsonString = jsonString.replace(/:\s*NULL\b/g, ': null');
                             console.log("Corrected JSON string for parsing:", correctedJsonString);
                             
                             const parsedResponse = JSON.parse(correctedJsonString);
                             console.log("Claude Response (Parsed JSON):", parsedResponse);
                             if (typeof parsedResponse === 'object' && parsedResponse !== null) {
                                 const finalResponse: Record<string, string | string[] | null> = {};
                                 const fieldTypeMap = new Map(fields.map(f => [f.identifier, f.type])); 
                                 for (const key in parsedResponse) {
                                      if (Object.prototype.hasOwnProperty.call(parsedResponse, key)) {
                                          // Skip any top-level keys that are literally "NULL"
                                          if (key === "NULL") {
                                              console.warn(`Claude responded with a top-level key "NULL". Skipping this key.`);
                                              continue;
                                          }
                                          const value = parsedResponse[key];
                                          // Ensure the key from LLM response actually corresponds to a requested field
                                          if (!fieldTypeMap.has(key)) {
                                              console.warn(`Claude responded with an unexpected key "${key}" not present in the original field request. Skipping.`);
                                              continue;
                                          }
                                          const expectedType = fieldTypeMap.get(key);
                                          if (expectedType === 'multiselect') {
                                              if (value === null || (Array.isArray(value) && value.every(item => typeof item === 'string')) || typeof value === 'string') {
                                                  finalResponse[key] = value; 
                                              } else {
                                                  console.warn(`Claude Response for multiselect field "${key}" was unexpected type (expected string, string[], or null):`, value, `-> Treating as null.`);
                                                  finalResponse[key] = null;
                                              }
                                          } else {
                                              if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                                                  finalResponse[key] = value === null ? null : String(value);
                                              } else {
                                                  console.warn(`Claude Response for non-multiselect field "${key}" was not string/null:`, value, `-> Converting to string or null.`);
                                                  finalResponse[key] = value === null || typeof value === 'undefined' ? null : String(value);
                                              }
                                          }
                                      }
                                  }
                                 return finalResponse;
                             } else {
                                 console.error(`\x1b[31mClaude response content was not a valid JSON object (Attempt ${currentAttempt}).\x1b[0m`);
                                 // Let it retry
                             }
                         } catch (parseError) {
                             console.error(`\x1b[31mError parsing Claude JSON response (Attempt ${currentAttempt}):\x1b[0m`, parseError);
                             console.error('\x1b[31mRaw Claude content was:\x1b[0m', rawContentString); // Corrected to rawContentString
                             // Let it retry
                         }
                     }
                 }
            }
        } catch (error: any) {
            console.error(`  Error during Claude call (Attempt ${currentAttempt}):`, error.message);
            if (currentAttempt >= maxRetries) {
                console.error(`\x1b[31mClaude call failed after ${maxRetries} attempts.\x1b[0m`);
                break;
            }
        }

        if (currentAttempt < maxRetries) {
            const delay = baseDelay * Math.pow(2, currentAttempt - 1);
            console.log(`  Waiting ${delay}ms before next retry...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    console.warn("Claude call failed after all retries. Returning empty result.");
    return {};
} 

export async function callLLMForApiAnswers(
    questions: { id: string; label: string; type: string; options?: string[]; isMandatory: boolean }[],
    profileData: Record<string, string>,
    eventName: string,
    config: Record<string, string>
): Promise<(string | string[] | boolean | null)[] | null> {
    console.log(`\n--- LLM Call for API Answers (Claude) - Event: ${eventName} ---`);
    if (questions.length === 0) {
        console.log("No questions to send to LLM for API answers.");
        return [];
    }

    const profileString = JSON.stringify(profileData);
    const questionsString = questions.map((q, index) => 
        `${index + 1}. Label: "${q.label}", Type: ${q.type}${q.options ? `, Options: [${q.options.map(o => `"${o}"`).join(', ')}]` : ''}, Mandatory: ${q.isMandatory}`
    ).join('\n');

    const systemPrompt = `You are an AI assistant that provides answers for event registration forms. Based on the user\'s profile and the questions provided, your task is to generate a JSON array of answers. \nIt is CRITICAL that each element in the array directly corresponds to a question in the exact order they are listed, and the total number of answers in the array MUST precisely match the total number of questions.\n\nKey Instructions:\n1.  Output Format: Return ONLY a single, valid JSON array. Do NOT include any other text, explanations, apologies, or markdown formatting (like \\\`\\\`\\\`json) outside of this JSON array. Your entire response must start with \'[\' and end with \']\'.\n2.  Answer Array Length: The JSON array of answers MUST contain exactly the same number of elements as there are questions. For example, if there are 5 questions, your JSON array must contain 5 answers.\n3.  Answer Types:\n    *   For text/input fields (e.g., \'text\', \'linkedin\', \'phone-number\'): Provide the answer as a string.\n    *   For dropdown/select fields: Provide the selected option as a string. Choose strictly from the provided options. If no option is a perfect match, select the closest one.\n    *   For multi-select fields: Provide a JSON array of selected option strings. Choose strictly from the provided options. If no options are suitable, provide an empty array [].\n    *   For boolean/checkbox fields (e.g., \'agree-check\', \'terms\'): Respond with a boolean value (true or false).\n4.  Mandatory vs. Optional Fields:\n    *   For *Mandatory* questions (marked as Mandatory): You MUST provide a best-effort answer. Do NOT use null. If the profile lacks information for a mandatory text field, use \"N/A\". For mandatory select/dropdowns, pick the most suitable or first option. For mandatory agree-check/terms, respond with true.\n    *   For *Non-Mandatory* (optional) questions: If the profile does not contain enough information, and you cannot infer a reasonable answer, return null (the literal JSON null, not the string \"null\") for that question\'s array element. For optional multi-select with no info, use an empty array [].\n5.  Goal: maximise the chance of being accepted. Many events are curated or approval-based, so always give the answer most likely to get the user in, even when the profile does not confirm it. This overrides rule 4 for these questions:\n    *   Engagement or prerequisite questions (followed us / joined our group / subscribed / will attend / attending another event / applied / signed up / read something) and Yes/No interest in the host's offering, partnerships, sponsorship or services: answer affirmatively ("Yes", "Done", or the most positive option).\n    *   Free text about goals, why you want to attend, what you bring, topics to discuss: write a confident, specific 1-3 sentence answer tailored to the event and based on the profile. Never answer N/A or leave it empty.\n    *   Choice questions about role, company type or seniority: pick the option matching the profile that is most valuable to organizers (e.g. founder, investor, decision-maker).\n    *   Contact questions: use the profile's Preferred Contact when one is set.\n    *   Do not invent identity documents (passport/NRIC digits), wallet addresses, UIDs, or promo/access/VIP/referral codes, and do not claim a regulatory status such as accredited investor unless the profile says so: use the profile value or N/A.\n\nUser Profile:\n${profileString}\n\nEvent Name: ${eventName}\n\nQuestions (Total: ${questions.length}):\n${questionsString}\n\nReminder: Your response MUST be a JSON array with exactly ${questions.length} elements, corresponding to the questions above, in order.\nExample for 3 questions (text, multi-select from options, mandatory agree-check):\n[\"My text answer\", [\"Option A\", \"Option C\"], true]\nExample for 2 questions (optional dropdown with no info, mandatory text with no profile info):\n[null, \"Attending\"]`;

    console.log("Sending sequential prompt to Claude (" + getClaudeModel(config) + " for API answers)...");

    let content: string | undefined;
    try {
        content = (await callClaude(systemPrompt, config)).text.trim();
    } catch (error: any) {
        console.error("Claude Sequential Answer call failed:", error.message);
        return null;
    }

    if (content) {
        console.log("Claude Sequential Answer Response Content (Raw):", content);
        let parsedJson: any = null;
        const errorLogs: string[] = [];
        let attemptedJsonString: string = "";

        // Attempt 1: Parse the whole content as is
        try {
            attemptedJsonString = content;
            parsedJson = JSON.parse(attemptedJsonString);
            console.log("Successfully parsed entire raw content as JSON array.");
        } catch (e1: any) {
            errorLogs.push(`Attempt 1 (parsing full content) failed: ${e1.message}`);
            
            // Attempt 2: Look for markdown ```json ... ``` block
            const markdownMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
            if (markdownMatch && markdownMatch[1]) {
                attemptedJsonString = markdownMatch[1].trim();
                console.log("Extracted JSON string from markdown block:", attemptedJsonString);
                try {
                    parsedJson = JSON.parse(attemptedJsonString);
                    console.log("Successfully parsed JSON from markdown block.");
                } catch (e2: any) {
                    errorLogs.push(`Attempt 2 (parsing markdown content) failed: ${e2.message}`);
                }
            } else {
                 errorLogs.push("Attempt 2 (markdown block) skipped: No markdown block found.");
            }

            // Attempt 3: Fallback to existing regex for a simple array (if still not parsed)
            if (!parsedJson) {
                // Regex to find the first standalone JSON array.
                // It looks for '[' not preceded by a quote (to avoid matching arrays inside strings),
                // and matches until the corresponding ']'
                const simpleArrayMatch = content.match(/(?<!")(\[[\s\S]*?\])(?!")/); 
                if (simpleArrayMatch && simpleArrayMatch[1]) {
                    attemptedJsonString = simpleArrayMatch[1].trim();
                    console.log("Extracted JSON array string using simple regex:", attemptedJsonString);
                    try {
                        parsedJson = JSON.parse(attemptedJsonString);
                        console.log("Successfully parsed JSON from simple array regex match.");
                    } catch (e3: any) {
                        errorLogs.push(`Attempt 3 (parsing simple regex content) failed: ${e3.message}`);
                    }
                } else {
                    errorLogs.push("Attempt 3 (simple regex) skipped: No simple array match found (or regex issue).");
                }
            }
        }

        if (parsedJson && Array.isArray(parsedJson)) {
            return parsedJson as (string | string[] | boolean | null)[];
        } else {
            console.error("Failed to parse content into a JSON array after all attempts.");
            errorLogs.forEach(log => console.error(`  - ${log}`));
            if (parsedJson && !Array.isArray(parsedJson)) {
                 console.error("  - Parsed content was valid JSON but not an array:", JSON.stringify(parsedJson).substring(0, 200));
            }
            // Log the string that was last attempted for parsing if all attempts failed and it's different from raw content
            if (attemptedJsonString !== content && errorLogs.length > 0 && !parsedJson) {
                 console.error("  - Last string attempted for parsing:", attemptedJsonString.substring(0, 500));
            }
            return null; 
        }
    } else {
        console.error("Claude Sequential Answer response content is empty.");
        return null;
    }
} 