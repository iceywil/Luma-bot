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
    console.log(`\n--- Choosing Best Free Ticket LLM Call ---`); 
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
    const prompt = promptTemplate
        .replace('{profileString}', profileString)
        .replace('{optionsString}', optionsString)
        .replace('{context}', context);

    console.log(`Profile Data (for context): ${profileString}`);
    console.log(`Free Ticket Options: [${optionsString}]`);
    console.log(`Sending prompt to LLM (Ollama deepseek-r1 for ticket choice)...`);

    try {
        const response = await fetch("http://localhost:11434/api/generate", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                "model": "deepseek-r1",
                "prompt": prompt,
                "stream": false
            })
        });

        if (response.ok) {
            const data = await response.json();
            const chosenTicket = data?.response?.trim();
            if (chosenTicket && chosenTicket.toUpperCase() !== 'NULL' && ticketOptions.includes(chosenTicket)) {
                 console.log(`LLM chose ticket: "${chosenTicket}"`);
                 return chosenTicket;
            } else {
                console.log('LLM did not provide a valid ticket choice or chose NULL.', chosenTicket);
                return null;
            }
        } else {
            console.error(`\x1b[31mLLM (Ticket Choice) API request failed:\x1b[0m`, response.status, response.statusText);
            const errorBody = await response.text(); 
            console.error("\x1b[31mError body:\x1b[0m", errorBody);
            return null;
        }
    } catch (error) {
        console.error("\x1b[31mError during fetch to LLM API (Ticket Choice):\x1b[0m", error);
        return null; 
    }
}

// Function to call LLM with a batch of fields
export async function callLLMBatched(
    fields: LLMFieldRequest[], 
    profileData: Record<string, string>,
    config: Record<string, string>
): Promise<Record<string, string | string[] | null>> {
    console.log(`\n--- Batch LLM Call ---`); 
    if (fields.length === 0) {
        console.log("No fields require LLM input.");
        return {};
    }

    // --- Prepare Prompt (as before) ---
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

    console.log(`Sending prompt to LLM (Ollama deepseek-r1)... (Max Retries: ${maxRetries})`);

    while (currentAttempt < maxRetries) {
        currentAttempt++;
        console.log(`  Attempt ${currentAttempt}/${maxRetries}...`);
        try {
            const response = await fetch("http://localhost:11434/api/generate", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    "model": "deepseek-r1",
                    "prompt": prompt,
                    "stream": false
                }),
                signal: AbortSignal.timeout(60000)
            });

            if (response.ok) {
                const data = await response.json();
                let rawContentString = data?.response;
                if (!rawContentString) {
                     console.error('\x1b[31mCould not extract content string from Ollama response (Attempt ${currentAttempt}):\x1b[0m', JSON.stringify(data, null, 2));
                     // Let it retry
                 } else {
                     console.log("Ollama Response Content (Raw):", rawContentString);
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
                         console.warn("Could not find any '{' in the Ollama response.");
                     }
                     if (!jsonString) {
                         console.error('\x1b[31mCould not find or extract JSON content in Ollama response (Attempt ${currentAttempt}).\x1b[0m');
                         // Let it retry
                     } else {
                         try {
                             // Add replacement logic before parsing
                             const correctedJsonString = jsonString.replace(/:\s*NULL\b/g, ': null');
                             console.log("Corrected JSON string for parsing:", correctedJsonString);
                             
                             const parsedResponse = JSON.parse(correctedJsonString);
                             console.log("Ollama Response (Parsed JSON):", parsedResponse);
                             if (typeof parsedResponse === 'object' && parsedResponse !== null) {
                                 const finalResponse: Record<string, string | string[] | null> = {};
                                 const fieldTypeMap = new Map(fields.map(f => [f.identifier, f.type])); 
                                 for (const key in parsedResponse) {
                                      if (Object.prototype.hasOwnProperty.call(parsedResponse, key)) {
                                          const value = parsedResponse[key];
                                          const expectedType = fieldTypeMap.get(key);
                                          if (expectedType === 'multiselect') {
                                              if (value === null || (Array.isArray(value) && value.every(item => typeof item === 'string')) || typeof value === 'string') {
                                                  finalResponse[key] = value; 
                                              } else {
                                                  console.warn(`Ollama Response for multiselect field "${key}" was unexpected type (expected string, string[], or null):`, value, `-> Treating as null.`);
                                                  finalResponse[key] = null;
                                              }
                                          } else {
                                              if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                                                  finalResponse[key] = value === null ? null : String(value);
                                              } else {
                                                  console.warn(`Ollama Response for non-multiselect field "${key}" was not string/null:`, value, `-> Converting to string or null.`);
                                                  finalResponse[key] = value === null || typeof value === 'undefined' ? null : String(value);
                                              }
                                          }
                                      }
                                  }
                                 return finalResponse;
                             } else {
                                 console.error('\x1b[31mOllama response content was not a valid JSON object (Attempt ${currentAttempt}).\x1b[0m');
                                 // Let it retry
                             }
                         } catch (parseError) {
                             console.error('\x1b[31mError parsing Ollama JSON response (Attempt ${currentAttempt}):\x1b[0m', parseError);
                             console.error('\x1b[31mRaw Ollama content was:\x1b[0m', jsonString);
                             // Let it retry
                         }
                     }
                 }
            } else { 
                console.error(`  Ollama API request failed (Attempt ${currentAttempt}):`, response.status, response.statusText);
                const errorBody = await response.text(); 
                console.error("  Error body:", errorBody);
                if (currentAttempt >= maxRetries) {
                    console.error(`\x1b[31mOllama API call failed after ${maxRetries} attempts.\x1b[0m`);
                    break;
                }
            }
        } catch (error: any) {
            console.error(`  Error during fetch to LLM API (Attempt ${currentAttempt}):\x1b[0m`, error.name, error.message);
            if (currentAttempt >= maxRetries) {
                console.error(`\x1b[31mOllama API call failed after ${maxRetries} attempts due to fetch error.\x1b[0m`);
                break;
            }
        }

        if (currentAttempt < maxRetries) {
            const delay = baseDelay * Math.pow(2, currentAttempt - 1);
            console.log(`  Waiting ${delay}ms before next retry...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    console.warn("Ollama call failed after all retries. Returning empty result.");
    return {};
} 