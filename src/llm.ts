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

// Function to call LLM to choose the best free ticket
export async function chooseBestFreeTicketLLM(
    ticketOptions: string[], 
    profileData: Record<string, string>,
    config: Record<string, string>
): Promise<string | null> { // Returns the name of the chosen ticket or null
    console.log(`\n--- Choosing Best Free Ticket LLM Call (Groq API) ---`); 
    if (ticketOptions.length === 0) {
        console.log("No free ticket options provided.");
        return null;
    }

    const groqApiKey = config.GROQ_API_KEY;
    if (!groqApiKey) {
        console.error("\x1b[31mGROQ_API_KEY not found in config.txt.\x1b[0m");
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
    console.log(`Sending prompt to Groq LLM (${config.GROQ_API_MODEL || 'llama-3.3-70b-versatile'} for ticket choice)...`);

    try {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${groqApiKey}`
            },
            body: JSON.stringify({
                "model": config.GROQ_API_MODEL || "llama-3.3-70b-versatile",
                "messages": [{ "role": "user", "content": systemMessage }],
                "stream": false
                // "temperature": 0.7, // Optional: Adjust temperature as needed
            })
        });

        if (response.ok) {
            const data = await response.json();
            const chosenTicket = data?.choices?.[0]?.message?.content?.trim();
            if (chosenTicket && chosenTicket.toUpperCase() !== 'NULL' && ticketOptions.includes(chosenTicket)) {
                 console.log(`Groq LLM chose ticket: "${chosenTicket}"`);
                 return chosenTicket;
            } else {
                console.log('Groq LLM did not provide a valid ticket choice or chose NULL.', chosenTicket);
                if (data?.choices?.[0]?.finish_reason === 'length') {
                    console.warn('Groq LLM response may have been truncated due to length.');
                }
                return null;
            }
        } else {
            console.error(`\x1b[31mGroq LLM (Ticket Choice) API request failed:\x1b[0m`, response.status, response.statusText);
            const errorBody = await response.text(); 
            console.error("\x1b[31mError body:\x1b[0m", errorBody);
            return null;
        }
    } catch (error) {
        console.error("\x1b[31mError during fetch to Groq LLM API (Ticket Choice):\x1b[0m", error);
        return null; 
    }
}

// Function to call LLM with a batch of fields
export async function callLLMBatched(
    fields: LLMFieldRequest[], 
    profileData: Record<string, string>,
    config: Record<string, string>
): Promise<Record<string, string | string[] | null>> {
    console.log(`\n--- Batch LLM Call (Groq API) ---`); 
    if (fields.length === 0) {
        console.log("No fields require LLM input.");
        return {};
    }

    const groqApiKey = config.GROQ_API_KEY;
    if (!groqApiKey) {
        console.error("\x1b[31mGROQ_API_KEY not found in config.txt.\x1b[0m");
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

    console.log(`Sending prompt to Groq LLM (${config.GROQ_API_MODEL || 'llama-3.1-8b-instant'})... (Max Retries: ${maxRetries})`);

    while (currentAttempt < maxRetries) {
        currentAttempt++;
        console.log(`  Attempt ${currentAttempt}/${maxRetries}...`);
        try {
            const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${groqApiKey}`
                },
                body: JSON.stringify({
                    "model": config.GROQ_API_MODEL || "llama-3.1-8b-instant",
                    "messages": [{ "role": "user", "content": prompt }],
                    "stream": false,
                    // "temperature": 0.2, // Lower temperature for more deterministic JSON output
                    // "response_format": { "type": "json_object" } // If supported by Groq and model
                }),
                signal: AbortSignal.timeout(90000) // Increased timeout to 90s for potentially larger payloads
            });

            if (response.ok) {
                const data = await response.json();
                let rawContentString = data?.choices?.[0]?.message?.content;

                if (data?.choices?.[0]?.finish_reason === 'length') {
                    console.warn('Groq LLM response may have been truncated due to length (Attempt ${currentAttempt}).');
                }

                if (!rawContentString) {
                     console.error('\x1b[31mCould not extract content string from Groq response (Attempt ${currentAttempt}):\x1b[0m', JSON.stringify(data, null, 2));
                     // Let it retry
                 } else {
                     console.log("Groq Response Content (Raw):", rawContentString);
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
                         console.warn("Could not find any '{' in the Groq response.");
                     }
                     if (!jsonString) {
                         console.error('\x1b[31mCould not find or extract JSON content in Groq response (Attempt ${currentAttempt}).\x1b[0m');
                         // Let it retry
                     } else {
                         try {
                             // Add replacement logic before parsing
                             const correctedJsonString = jsonString.replace(/:\s*NULL\b/g, ': null');
                             console.log("Corrected JSON string for parsing:", correctedJsonString);
                             
                             const parsedResponse = JSON.parse(correctedJsonString);
                             console.log("Groq Response (Parsed JSON):", parsedResponse);
                             if (typeof parsedResponse === 'object' && parsedResponse !== null) {
                                 const finalResponse: Record<string, string | string[] | null> = {};
                                 const fieldTypeMap = new Map(fields.map(f => [f.identifier, f.type])); 
                                 for (const key in parsedResponse) {
                                      if (Object.prototype.hasOwnProperty.call(parsedResponse, key)) {
                                          // Skip any top-level keys that are literally "NULL"
                                          if (key === "NULL") {
                                              console.warn(`Groq LLM responded with a top-level key "NULL". Skipping this key.`);
                                              continue;
                                          }
                                          const value = parsedResponse[key];
                                          // Ensure the key from LLM response actually corresponds to a requested field
                                          if (!fieldTypeMap.has(key)) {
                                              console.warn(`Groq LLM responded with an unexpected key "${key}" not present in the original field request. Skipping.`);
                                              continue;
                                          }
                                          const expectedType = fieldTypeMap.get(key);
                                          if (expectedType === 'multiselect') {
                                              if (value === null || (Array.isArray(value) && value.every(item => typeof item === 'string')) || typeof value === 'string') {
                                                  finalResponse[key] = value; 
                                              } else {
                                                  console.warn(`Groq LLM Response for multiselect field "${key}" was unexpected type (expected string, string[], or null):`, value, `-> Treating as null.`);
                                                  finalResponse[key] = null;
                                              }
                                          } else {
                                              if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                                                  finalResponse[key] = value === null ? null : String(value);
                                              } else {
                                                  console.warn(`Groq LLM Response for non-multiselect field "${key}" was not string/null:`, value, `-> Converting to string or null.`);
                                                  finalResponse[key] = value === null || typeof value === 'undefined' ? null : String(value);
                                              }
                                          }
                                      }
                                  }
                                 return finalResponse;
                             } else {
                                 console.error('\x1b[31mGroq response content was not a valid JSON object (Attempt ${currentAttempt}).\x1b[0m');
                                 // Let it retry
                             }
                         } catch (parseError) {
                             console.error('\x1b[31mError parsing Groq JSON response (Attempt ${currentAttempt}):\x1b[0m', parseError);
                             console.error('\x1b[31mRaw Groq content was:\x1b[0m', rawContentString); // Corrected to rawContentString
                             // Let it retry
                         }
                     }
                 }
            } else { 
                console.error(`  Groq API request failed (Attempt ${currentAttempt}):`, response.status, response.statusText);
                const errorBody = await response.text(); 
                console.error("  Error body:", errorBody);
                if (currentAttempt >= maxRetries) {
                    console.error(`\x1b[31mGroq API call failed after ${maxRetries} attempts.\x1b[0m`);
                    break;
                }
            }
        } catch (error: any) {
            console.error(`  Error during fetch to Groq API (Attempt ${currentAttempt}):\x1b[0m`, error.name, error.message);
            if (error.name === 'AbortSignalError') { // Specifically handle timeout
                console.warn(`  Groq API call timed out after ${90000 / 1000} seconds (Attempt ${currentAttempt}).`);
            }
            if (currentAttempt >= maxRetries) {
                console.error(`\x1b[31mGroq API call failed after ${maxRetries} attempts due to fetch error.\x1b[0m`);
                break;
            }
        }

        if (currentAttempt < maxRetries) {
            const delay = baseDelay * Math.pow(2, currentAttempt - 1);
            console.log(`  Waiting ${delay}ms before next retry...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    console.warn("Groq LLM call failed after all retries. Returning empty result.");
    return {};
} 

// --- New LLM Function for API Registration Questions ---
async function callGroqAPIWithRetries(
    messages: { role: string; content: string }[],
    apiKey: string,
    model: string,
    temperature: number = 0.1,
    // stream: boolean = false, // Assuming stream is false for this specific sequential answer use case
    maxRetries: number = 3,
    initialDelay: number = 2000
): Promise<any | null> {
    let attempt = 0;
    let delay = initialDelay;
    while (attempt < maxRetries) {
        attempt++;
        console.log(`  Groq API call attempt ${attempt}/${maxRetries} for model ${model}...`);
        try {
            const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    "model": model,
                    "messages": messages,
                    "stream": false, // Keep stream false for this helper, as we parse full content
                    "temperature": temperature,
                }),
                signal: AbortSignal.timeout(90000) // 90 second timeout per attempt
            });

            if (response.ok) {
                const data = await response.json();
                if (data?.choices?.[0]?.finish_reason === 'length') {
                    console.warn(`Groq LLM response for model ${model} may have been truncated due to length.`);
                }
                return data;
            } else {
                console.error(`Groq API request failed (attempt ${attempt}/${maxRetries}):`, response.status, response.statusText);
                const errorBody = await response.text();
                console.error("Error body:", errorBody.substring(0, 500)); // Log first 500 chars of error
                
                let shouldRetry = false;
                let currentDelay = delay;

                if (response.status === 429) { // Specifically handle 429 Too Many Requests
                    console.warn("Groq API returned 429 (Too Many Requests).");
                    shouldRetry = true;
                    currentDelay = 10000; // Wait 10 seconds for 429 errors
                } else if (response.status >= 500) { // Retry on general server errors
                    shouldRetry = true;
                    // currentDelay will use the existing `delay` value which handles exponential backoff
                }

                if (shouldRetry && attempt < maxRetries) {
                    console.log(`Retrying in ${currentDelay / 1000}s...`);
                    await new Promise(resolve => setTimeout(resolve, currentDelay)); // Use currentDelay
                    if (response.status !== 429) { 
                        delay *= 2; // Apply exponential backoff for next non-429 retryable error
                    }
                    continue;
                } else if (shouldRetry && attempt >= maxRetries) {
                    console.error(`Max retries reached for status ${response.status}.`);
                    return null; 
                } else {
                    // Don't retry for other client-side errors like 400, 401, 403
                    console.error(`Not retrying for status ${response.status}.`);
                    return null; 
                }
            }
        } catch (error: any) {
            console.error(`Error during fetch to Groq API (attempt ${attempt}/${maxRetries}):`, error.name, error.message);
            if (attempt < maxRetries) {
                console.log(`Retrying in ${delay / 1000}s...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2;
            }
        }
    }
    console.error(`Failed to get valid response from Groq API for model ${model} after ${maxRetries} attempts.`);
    return null;
}

export async function callLLMForApiAnswers(
    questions: { id: string; label: string; type: string; options?: string[]; isMandatory: boolean }[],
    profileData: Record<string, string>,
    eventName: string,
    config: Record<string, string>
): Promise<(string | string[] | boolean | null)[] | null> {
    console.log(`\n--- LLM Call for API Answers (Groq API) - Event: ${eventName} ---`);
    if (questions.length === 0) {
        console.log("No questions to send to LLM for API answers.");
        return [];
    }

    const groqApiKey = config.GROQ_API_KEY;
    if (!groqApiKey) {
        console.error("\x1b[31mGROQ_API_KEY not found in config.txt.\x1b[0m");
        return null;
    }

    const profileString = JSON.stringify(profileData);
    const questionsString = questions.map((q, index) => 
        `${index + 1}. Label: "${q.label}", Type: ${q.type}${q.options ? `, Options: [${q.options.map(o => `"${o}"`).join(', ')}]` : ''}, Mandatory: ${q.isMandatory}`
    ).join('\n');

    const systemPrompt = `You are an AI assistant that provides answers for event registration forms. Based on the user\'s profile and the questions provided, your task is to generate a JSON array of answers. \nIt is CRITICAL that each element in the array directly corresponds to a question in the exact order they are listed, and the total number of answers in the array MUST precisely match the total number of questions.\n\nKey Instructions:\n1.  Output Format: Return ONLY a single, valid JSON array. Do NOT include any other text, explanations, apologies, or markdown formatting (like \\\`\\\`\\\`json) outside of this JSON array. Your entire response must start with \'[\' and end with \']\'.\n2.  Answer Array Length: The JSON array of answers MUST contain exactly the same number of elements as there are questions. For example, if there are 5 questions, your JSON array must contain 5 answers.\n3.  Answer Types:\n    *   For text/input fields (e.g., \'text\', \'linkedin\', \'phone-number\'): Provide the answer as a string.\n    *   For dropdown/select fields: Provide the selected option as a string. Choose strictly from the provided options. If no option is a perfect match, select the closest one.\n    *   For multi-select fields: Provide a JSON array of selected option strings. Choose strictly from the provided options. If no options are suitable, provide an empty array [].\n    *   For boolean/checkbox fields (e.g., \'agree-check\', \'terms\'): Respond with a boolean value (true or false).\n4.  Mandatory vs. Optional Fields:\n    *   For *Mandatory* questions (marked as Mandatory): You MUST provide a best-effort answer. Do NOT use null. If the profile lacks information for a mandatory text field, use \"N/A\". For mandatory select/dropdowns, pick the most suitable or first option. For mandatory agree-check/terms, respond with true.\n    *   For *Non-Mandatory* (optional) questions: If the profile does not contain enough information, and you cannot infer a reasonable answer, return null (the literal JSON null, not the string \"null\") for that question\'s array element. For optional multi-select with no info, use an empty array [].\n\nUser Profile:\n${profileString}\n\nEvent Name: ${eventName}\n\nQuestions (Total: ${questions.length}):\n${questionsString}\n\nReminder: Your response MUST be a JSON array with exactly ${questions.length} elements, corresponding to the questions above, in order.\nExample for 3 questions (text, multi-select from options, mandatory agree-check):\n[\"My text answer\", [\"Option A\", \"Option C\"], true]\nExample for 2 questions (optional dropdown with no info, mandatory text with no profile info):\n[null, \"Attending\"]`;

    const messages = [{ role: 'system', content: systemPrompt }];

    console.log("Sending sequential prompt to Groq LLM (" + (config.GROQ_API_MODEL_SEQ_ANSWERS || config.GROQ_API_MODEL || 'llama-3.1-8b-instant') + " for API answers)... (Max Retries: 3)"); // Retries handled by callGroqAPIWithRetries

    const response = await callGroqAPIWithRetries(
        messages, 
        groqApiKey, 
        config.GROQ_API_MODEL_SEQ_ANSWERS || 'llama-3.1-8b-instant', 
        0.1 // Temperature
        // maxRetries and initialDelay will use default values from callGroqAPIWithRetries definition
    );

    if (!response || !response.choices || response.choices.length === 0) {
        console.error("Groq API Sequential Answer call failed or returned no choices.");
        return null;
    }

    const content = response.choices[0]?.message?.content?.trim();

    if (content) {
        console.log("Groq API Sequential Answer Response Content (Raw):", content);
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
        console.error("Groq API Sequential Answer response content is empty.");
        return null;
    }
} 