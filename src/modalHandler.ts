import { Page, Locator } from 'playwright';
import readline from 'readline/promises';
import { readProfile, updateProfile } from './config';
import { callLLMBatched, LLMFieldRequest } from './llm';
import { findFieldByLabel } from './domUtils';
import * as fs from 'fs/promises';

// --- Selectors (Modal Scope) ---
const modalSelector = 'div.lux-overlay.glass'; 
const formInputSelector = 'input:not([type="hidden"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]), select, textarea';
const checkboxContainerSelector = 'div.lux-checkbox'; 
const checkboxInputSelector = 'input[type="checkbox"]'; 
const checkboxLabelSelector = 'label.text-label > div'; 
const checkboxClickTargetSelector = 'label.checkbox-icon'; // Preferred click target
const submitButtonSelector = 'div.lux-collapse.shown > button';

// ** PLACEHOLDERS - VERIFY THESE BY INSPECTING THE DROPDOWN **
// const customSelectDropdownSelector = '.dropdown-menu-container, [role="listbox"]'; // Container for options
// const customSelectOptionSelector = '.dropdown-option-item, [role="option"]'; // Individual option items
// ** VERIFIED SELECTORS from select-debug.ts **
const customSelectDropdownSelector = 'div.lux-menu'; 
const customSelectOptionSelector = 'div.lux-menu-item'; 

// Add selectors for the Terms Modal (copied from eventProcessor.ts)
const termsModalSelector = 'div.lux-modal:has-text("Accept Terms")';
const termsModalTextareaSelector = 'textarea.lux-naked-input';
const termsModalSubmitButtonSelector = 'button:has-text("Sign & Accept")';

// --- Helper to check if an input acts like a select ---
function isCustomSelectTrigger(tagName: string, identifier: string, placeholder: string | null): boolean {
    if (tagName !== 'input') return false;
    const lowerIdentifier = identifier.toLowerCase();
    const lowerPlaceholder = placeholder?.toLowerCase() || '';
    return lowerIdentifier.includes('select') || 
           lowerIdentifier.includes('choose') || 
           lowerIdentifier.includes('type') || 
           lowerIdentifier.includes('role') || 
           lowerPlaceholder.includes('select') || 
           lowerPlaceholder.includes('sélectionnez') || 
           lowerPlaceholder.includes('choose'); 
}

// --- Add Helper Function for Fallback --- 
async function attemptFirstOptionFallback(
    fieldRequest: LLMFieldRequest,
    page: Page,
    modal: Locator,
    logPrefix: string = '[Fallback]' // Allow customizing log prefix
): Promise<boolean> {
    const { identifier, type, isMandatory, options } = fieldRequest;
    if (!isMandatory || (type !== 'select' && type !== 'multiselect')) {
        // Should not be called in this case, but good safeguard
        return false; 
    }

    console.warn(`${logPrefix} Attempting fallback to first option for mandatory ${type} field "${identifier}".`);
    if (options && options.length > 0) {
        const firstOptionText = options[0];
        console.log(`${logPrefix} First available option: "${firstOptionText}". Attempting to select...`);
        const freshLocator = await findFieldByLabel(modal, identifier, type);
        if (!freshLocator) {
            console.error(`\x1b[31m ${logPrefix} Could not re-find field "${identifier}" to select first option.\x1b[0m`);
            return false;
        }
        try {
            await freshLocator.waitFor({ state: 'visible', timeout: 5000 });
            const tagName = await freshLocator.evaluate(el => el.tagName.toLowerCase());
            if (tagName === 'select') { // Standard select
                 await freshLocator.selectOption({ label: firstOptionText }); 
                 console.log(`${logPrefix} Selected first option in standard select.`);
                 return true; // Success
            } else { // Custom select/multiselect
                 await freshLocator.click({ timeout: 5000 }); 
                 await page.waitForTimeout(300);
                 let specificDropdownSelector = customSelectDropdownSelector;
                 const ariaControls = await freshLocator.getAttribute('aria-controls');
                 if (ariaControls) specificDropdownSelector = `#${ariaControls}`;
                 const dropdown = page.locator(specificDropdownSelector).first();
                 await dropdown.waitFor({ state: 'visible', timeout: 5000 });
                 const optionToClick = dropdown.locator(`${customSelectOptionSelector}:has-text("${firstOptionText}")`).first();
                 if (await optionToClick.isVisible({ timeout: 1000 })) {
                     await optionToClick.click({ timeout: 5000 });
                     console.log(`${logPrefix} Clicked first option in custom dropdown: "${firstOptionText}"`);
                     // Close dropdown
                     try {
                         await page.locator('body').click({ position: { x: 0, y: 0 }, delay: 100, force: true });
                         await dropdown.waitFor({ state: 'hidden', timeout: 2000 });
                     } catch { console.warn(`${logPrefix} Could not confirm dropdown closed after fallback selection.`)} 
                     return true; // Success
                 } else {
                     console.error(`\x1b[31m ${logPrefix} Could not find/click first option text "${firstOptionText}" in custom dropdown.\x1b[0m`);
                     // Attempt to close dropdown anyway
                     try { await page.locator('body').click({ position: { x: 0, y: 0 }, delay: 100, force: true }); } catch {} 
                     return false; // Failure
                 }
            }
        } catch (fallbackError) {
            console.error(`\x1b[31m ${logPrefix} Error selecting first option for "${identifier}":\x1b[0m`, fallbackError);
            return false; // Failure
        }
    } else {
         console.warn(`${logPrefix} No options available for mandatory field "${identifier}". Cannot fallback.`);
         return false; // Failure
    }
}
// --- End Helper Function ---

// --- ADDED: Helper function for Text N/A Fallback ---
async function attemptTextNAFallback(
    fieldRequest: LLMFieldRequest,
    modal: Locator,
    logPrefix: string = '[Fallback]' // Allow customizing log prefix
): Promise<boolean> {
    const { identifier, type, isMandatory } = fieldRequest;
    if (!isMandatory || type !== 'text') {
        // Should not be called in this case
        return false;
    }
    console.warn(`${logPrefix} Mandatory text field "${identifier}" needs value. Attempting fallback to \"n/a\".`);
    const freshLocator = await findFieldByLabel(modal, identifier, type);
    if (!freshLocator) {
        console.error(`\x1b[31m ${logPrefix} Could not re-find field "${identifier}" to fill with \"n/a\".\x1b[0m`);
        return false;
    }
    try {
        await freshLocator.waitFor({ state: 'visible', timeout: 5000 });
        await freshLocator.fill('n/a');
        console.log(`${logPrefix} Filled text field "${identifier}" with \"n/a\".`);
        // Note: We don't update filledModalData here, let the calling function do it if needed
        return true; // Success
    } catch (textFallbackError) {
        console.error(`\x1b[31m ${logPrefix} Error filling text field "${identifier}" with \"n/a\":\x1b[0m`, textFallbackError);
        return false; // Failure
    }
}
// --- End Text Fallback Helper ---

export async function handleModal(page: Page, config: Record<string, string>): Promise<Record<string, string | string[] | null> | null> {
    // --- Define rl and modal outside try block for finally/catch access ---
    let rl: readline.Interface | null = null;
    let modal: Locator | null = null;
    let success = false; // Flag to track if submission was likely successful
    const filledModalData: Record<string, string | string[] | null> = {}; // Initialize object to collect filled data
    const llmUpdates: Record<string, string | string[] | null> = {};
    const fieldsToAskLLM: LLMFieldRequest[] = [];

    try {
        // --- Initialize rl and modal inside try block ---
        rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        console.log('\n--- Processing Modal Form ---');
        
        await page.waitForSelector(modalSelector, { state: 'visible', timeout: 15000 }); 
        console.log('Popup modal detected.');
        modal = page.locator(modalSelector); // Assign to the outer scoped variable
        const profileData = await readProfile();
        
        // --- Pass 1: Process Inputs/Selects/Textareas & Collect for LLM ---
        console.log('--- Pass 1: Identifying & Processing Form Fields ---');
        
        // --- Wait for the Submit Button --- (Keep this)
        console.log(`[Pass 1 DEBUG] Waiting for submit button (${submitButtonSelector}) to be visible...`);
        try {
             await modal.locator(submitButtonSelector).first().waitFor({ state: 'visible', timeout: 10000 });
             console.log(`[Pass 1 DEBUG] Submit button is visible. Proceeding to get fields.`);
        } catch (waitError) {
             console.warn(`[Pass 1 DEBUG] Submit button did not become visible quickly. Proceeding anyway.`);
        }
        // --- End wait for submit button ---

        // --- Define Field Selectors ---
        const inputSelector = 'input:not([type="hidden"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"])';
        const selectSelector = 'select';
        const textareaSelector = 'textarea';
        const multiSelectTriggerSelector = 'div.lux-menu-trigger-wrapper div.luma-input span';
        // Combine selectors
        const allFieldSelectors = [inputSelector, selectSelector, textareaSelector, multiSelectTriggerSelector].join(', ');

        const fields = modal.locator(allFieldSelectors);
        const fieldCount = await fields.count();
        console.log(`[Pass 1 DEBUG] Found ${fieldCount} potential field elements using combined selector: ${allFieldSelectors}`);

        for (let i = 0; i < fieldCount; i++) {
            const field = fields.nth(i);
            const tagName = await field.evaluate(el => el.tagName.toLowerCase());
            
            // --- Get Field Identifiers (Label, Name, Placeholder, ID) ---
            let fieldId = await field.getAttribute('id');
            let fieldName = await field.getAttribute('name');
            let fieldPlaceholder = await field.getAttribute('placeholder'); // For <input>
            let labelText = '';
            let placeholderText = fieldPlaceholder; // Use input placeholder initially
            let spanText = '';

            if (fieldId) {
                const labelLocator = modal.locator(`label[for="${fieldId}"]`).first();
                if (await labelLocator.isVisible({ timeout: 50 })) { // Quick check
                   labelText = await labelLocator.textContent() || '';
                } 
            }
            // If no label found via `for`, try finding a preceding/parent label (common for custom controls)
            if (!labelText) {
                 try {
                     const complexLabel = await field.locator('xpath=./ancestor::*[./label][1]/label | ./preceding::label[1]').first();
                     if (await complexLabel.isVisible({timeout: 50})){
                          labelText = await complexLabel.textContent() || '';
                     }
                 } catch (e) {/* ignore */} 
            }
            if (tagName === 'span') {
                spanText = await field.textContent() || '';
            }
            
            // --- Get Specific Text for Div Trigger ---
            let isDivTrigger = false;
            if (tagName === 'div' && await field.evaluate(el => el.matches('div.lux-menu-trigger-wrapper'))) {
                isDivTrigger = true;
                const innerPlaceholder = field.locator('span.placeholder').first();
                if (await innerPlaceholder.isVisible({timeout: 50})) {
                    placeholderText = await innerPlaceholder.textContent() || fieldPlaceholder; 
                }
            }
            // --- End Get Specific Text ---
            
            let rawIdentifier = labelText.trim() || fieldName || placeholderText?.trim() || spanText.trim() || `field_${i}`;
            const isMandatory = rawIdentifier.trim().endsWith('*');
            const fieldIdentifier = rawIdentifier.replace(/\s*\*$/, '').trim();

            console.log(`[Pass 1 DEBUG] Field #${i}: Tag="${tagName}", ID="${fieldId}", Name="${fieldName}", Placeholder="${placeholderText}", Label="${labelText.trim()}", SpanText="${spanText.trim()}", Identifier="${fieldIdentifier}"`);

            // --- Determine Field Type & Custom Trigger Status (Rewritten Logic) ---
            let fieldType: LLMFieldRequest['type'] = 'text'; 
            let isCustomSelect = false; // Is it a custom trigger needing option extraction?
            
            if (tagName === 'select') {
                fieldType = 'select';
                isCustomSelect = false;
            } else if (tagName === 'textarea') {
                fieldType = 'text';
                isCustomSelect = false;
            } else if (tagName === 'input') {
                // Check if input has aria-haspopup="listbox" OR placeholder="Select an option"
                const hasPopup = await field.getAttribute('aria-haspopup');
                const placeholderValue = await field.getAttribute('placeholder'); // Get placeholder
                console.log(`[Pass 1 DEBUG] Input aria-haspopup: "${hasPopup}", placeholder: "${placeholderValue}"`); 
                
                if (hasPopup === 'listbox' || placeholderValue === 'Select an option') {
                     const reason = hasPopup === 'listbox' ? 'aria-haspopup' : 'placeholder';
                     console.log(`[Pass 1 DEBUG] Input identified as Custom Select (Single) via ${reason}.`);
                     fieldType = 'select';
                     isCustomSelect = true;
                 } else {
                     // Otherwise, assume regular text input
                     console.log(`[Pass 1 DEBUG] Input treated as text.`);
                     fieldType = 'text'; 
                     isCustomSelect = false;
                 }
            } else if (tagName === 'span' && await field.evaluate((el, selector) => el.matches(selector), multiSelectTriggerSelector)) { // Pass selector to evaluate
                 console.log(`[Pass 1 DEBUG] Span identified as Multi-Select trigger via selector.`);
                 fieldType = 'multiselect'; 
                 isCustomSelect = true;
            } else {
                 // Skip any other tags not explicitly handled unless they somehow matched the combined selector
                 console.log(`[Pass 1 DEBUG] Skipping element matched by combined selector but not handled by logic: ${tagName}`);
                 continue; 
            }

            // --- Don't process if identifier is missing (likely internal/unlabelled element) ---
            if (!fieldIdentifier || fieldIdentifier.startsWith('field_')) { // Basic check
                 console.log(`[Pass 1 DEBUG] Skipping field with missing/generic identifier (Tag: ${tagName}).`);
                 continue;
            }

            console.log(`Processing Field: "${fieldIdentifier}" (Tag: ${tagName}, Determined Type: ${fieldType})${isMandatory ? ' [Mandatory]' : ''}${isCustomSelect ? ' [Custom Select Trigger]' : ''}`);

            // --- Check Visibility/Editability (Adjust for Divs) ---
            const isVisible = await field.isVisible();
            const isEditable = tagName === 'input' || tagName === 'textarea' || tagName === 'select' ? await field.isEditable() : true;
            if (!isVisible || (!isEditable && !isCustomSelect)) { 
                console.log(`  Skipping: Not visible or not interactable.`); 
                continue; 
            }

            // Declare handled flag here
            let handled = false;

            // --- Pre-filled Value Check (Only for Input/Textarea) ---
            if (tagName === 'input' || tagName === 'textarea') {
                const currentValue = await field.inputValue();
                if (!isCustomSelect && currentValue) { 
                    console.log(`  Using pre-filled value: "${currentValue}".`); 
                    console.log(`  Adding to filledModalData (pre-filled): { "${fieldIdentifier}": "${currentValue}" }`);
                    filledModalData[fieldIdentifier] = currentValue;
                    handled = true; 
                    continue; 
                }
            } 
            // (Note: Getting pre-filled for custom selects/spans is complex, skipping for now)

            // --- Profile Check --- (Only for text inputs)
            let valueToFill: string | null = null;
            let options: string[] | undefined = undefined;
            if (!handled && fieldType === 'text') {
                const profileKey = Object.keys(profileData).find(key =>
                    key.toLowerCase() === fieldIdentifier.toLowerCase() ||
                    key.toLowerCase() === fieldName?.toLowerCase()
                );
                if (profileKey) {
                    valueToFill = profileData[profileKey];
                    console.log(`  Found in profile: "${profileKey}" = "${valueToFill}".`);
                    try {
                        if (typeof valueToFill === 'string') {
                            await field.fill(valueToFill);
                            console.log(`  Filled text input from profile.`);
                            console.log(`  Adding to filledModalData (profile): { "${fieldIdentifier}": "${valueToFill}" }`);
                            filledModalData[fieldIdentifier] = valueToFill;
                            handled = true;
                        } else {
                             console.warn('  Profile value is null, cannot fill text input.');
                        }
                    } catch (fillError) {
                        console.error('\x1b[31m  Failed to fill text input from profile:\x1b[0m', fillError);
                    }
                }
            }

            // --- Get Options if Custom Select/Multiselect --- 
            if (isCustomSelect) {
                console.log('  Attempting to extract custom select options...');
                try {
                    await field.click({ timeout: 5000, force: true }); 
                    await page.waitForTimeout(300);

                    const dropdown = page.locator(customSelectDropdownSelector).first(); 
                    await dropdown.waitFor({ state: 'visible', timeout: 5000 });
                    options = await dropdown.locator(customSelectOptionSelector).allTextContents();
                    options = options.map(opt => opt.trim()).filter(Boolean); 
                    console.log(`  Extracted options: [${options?.join(', ') ?? ''}]`);
                    
                    // Close dropdown
                    await page.locator('body').click({ position: { x: 0, y: 0 }, delay: 100, force: true }); 
                    await dropdown.waitFor({ state: 'hidden', timeout: 2000 }); 
                    console.log('  Closed custom select dropdown after extraction.');
                    await page.waitForTimeout(200); 
                } catch (optionError) {
                     console.error('\x1b[31m  Failed to extract custom select options:\x1b[0m', optionError);
                     options = []; 
                     // *** Save HTML for debugging extraction failure ***
                     try {
                          const html = await page.content();
                          const filename = `option_extract_fail_${fieldIdentifier.replace(/[^a-z0-9]/gi, '')}_${Date.now()}.html`;
                          await fs.writeFile(filename, html);
                          console.log(`  Saved page HTML to ${filename} for debugging extraction failure.`);
                     } catch (saveError) {
                          console.error('  Error saving debug HTML:', saveError);
                     }
                     // *** End Save HTML ***
                }
            } else if (fieldType === 'select' && tagName === 'select') { // Handle standard <select> option extraction
                 options = await field.locator('option').evaluateAll(opts =>
                     opts.map(opt => (opt as HTMLOptionElement).value || opt.textContent || '').filter(Boolean)
                 );
                 console.log(`  Extracted standard select options: [${options.join(', ')}]`);
            }

            // --- Add to LLM Batch if Not Handled --- 
            if (!handled) {
                console.log(`  Adding to LLM batch.`);
                fieldsToAskLLM.push({ identifier: fieldIdentifier, type: fieldType, options, locator: field, isMandatory });
            }

            await page.waitForTimeout(100);
        }
        
        // --- Pass 2: Process Checkboxes & Collect for LLM (Restored) ---
        console.log('\n--- Pass 2: Processing Checkboxes & Collecting for LLM (Modal Context) ---');
        const checkboxContainers = modal.locator(checkboxContainerSelector);
        const checkboxCount = await checkboxContainers.count();
        for (let i = 0; i < checkboxCount; i++) {
            const container = checkboxContainers.nth(i);
            const checkboxInput = container.locator(checkboxInputSelector).first();
            const labelElement = container.locator(checkboxLabelSelector).first();
            const clickTarget = container.locator(checkboxClickTargetSelector).first(); 
            let rawCheckboxLabel = await labelElement.textContent().catch(() => '') ?? '';
            const isMandatory = rawCheckboxLabel.trim().endsWith('*');
            let checkboxLabel = rawCheckboxLabel.replace(/\s*\*$/, '').trim();
            console.log(`Processing Checkbox (Modal): "${checkboxLabel}"${isMandatory ? ' [Mandatory]' : ''}`);

            if (!(await checkboxInput.isVisible({ timeout: 1000 }))) { console.log('  Skipping: Not visible.'); continue; }
            if (await checkboxInput.isChecked()) { console.log('  Skipping: Already checked.'); continue; }

            let handled = false;
            let needLlm = false;

            if (isMandatory) {
                console.log('  Mandatory checkbox detected. Attempting to check...');
                try {
                    await clickTarget.waitFor({ state: 'visible', timeout: 5000 });
                    await clickTarget.click({ timeout: 10000 }); 

                    if (await checkboxInput.isChecked()) {
                        console.log('  Checked mandatory checkbox successfully (Immediate Check).');
                        console.log(`  Adding to filledModalData (mandatory checkbox): { "${checkboxLabel}": "Yes" }`);
                        filledModalData[checkboxLabel] = 'Yes';
                        handled = true;
                    } else {
                         console.warn('  Clicked mandatory checkbox, but input did not become checked immediately. Checking for Terms Modal...');
                         // --- Check for Terms Modal (within modalHandler) --- 
                         try {
                             const termsModal = page.locator(termsModalSelector); // Use page context for this overlay modal
                             await termsModal.waitFor({ state: 'visible', timeout: 4000 }); 
                             console.log('  Detected "Accept Terms" modal after modal checkbox click.');
                             
                             // We already read profileData earlier in handleModal
                             const fullName = profileData['Name']; 
                             
                             if (!fullName) {
                                 console.error('\x1b[31m  Cannot sign terms: Full Name not found in profile.txt (expected key: Name).\x1b[0m');
                                 success = false; // Mark overall modal submission as failed
                                 handled = false; // Checkbox step failed
                             } else {
                                 const textarea = termsModal.locator(termsModalTextareaSelector);
                                 const submitButton = termsModal.locator(termsModalSubmitButtonSelector);
                                 
                                 console.log(`  Filling signature with name: "${fullName}"`);
                                 await textarea.fill(fullName);
                                 await submitButton.click({ timeout: 5000 });
                                 console.log('  Clicked "Sign & Accept". Waiting for terms modal to close...');
                                 await termsModal.waitFor({ state: 'hidden', timeout: 5000 });
                                 console.log('  Terms modal closed successfully.');
                                 // Assume checkbox is implicitly handled by signing terms
                                 console.log(`  Adding to filledModalData (mandatory checkbox via terms): { "${checkboxLabel}": "Yes" }`);
                                 filledModalData[checkboxLabel] = 'Yes'; 
                                 handled = true; // SUCCESS: Modal handled
                                 await page.waitForTimeout(500); 
                             }
                         } catch (termsModalError: any) {
                             if (termsModalError.name === 'TimeoutError') {
                                  console.log('  No "Accept Terms" modal appeared (or timed out).');
                                  // If no modal and not checked, it's a failure for mandatory
                                  console.error('\x1b[31m Mandatory checkbox was clicked, not checked, and no terms modal appeared.\x1b[0m');
                                  success = false; // Mark overall modal submission as failed
                                  handled = false;
                             } else {
                                  console.error('\x1b[31m  Error interacting with "Accept Terms" modal:\x1b[0m', termsModalError);
                                  success = false; // Mark overall modal submission as failed
                                  handled = false; // Checkbox step failed
                             }
                         }
                         // --- End Check for Terms Modal ---
                    }
                } catch (checkError) { 
                    console.error('\x1b[31m  Failed to click mandatory checkbox container in modal:\x1b[0m', checkError);
                    success = false; // Mark overall modal submission as failed
                    handled = false; 
                }
            } else {
                 // Optional Checkbox within the modal - should be handled by LLM in Pass 3
                 needLlm = true;
            }
            
            if (needLlm) {
                console.log('  Optional checkbox in modal: Adding to LLM batch.');
                fieldsToAskLLM.push({ identifier: checkboxLabel, type: 'checkbox', locator: clickTarget, isMandatory }); 
            }
             if (handled) await page.waitForTimeout(150);
        }
        // --- End Restored Pass 2 ---
        
        // --- Pass 3: Call LLM & Handle Responses/User Prompts ---
        console.log('\n--- Pass 3: Calling LLM & Handling Responses/User Prompts ---');
        let llmResponseMap: Map<string, string | string[] | null> = new Map();
        if (fieldsToAskLLM.length > 0) {
            // Identify fields needing LLM input (based on original Pass 2 logic)
            const fieldsForLLMCall = fieldsToAskLLM.filter(f => !filledModalData[f.identifier]); // Example filter
            
            const llmResults = await callLLMBatched(fieldsForLLMCall, profileData, config);
            
            // --- Revised Logic: Process raw LLM results, clean keys --- 
            console.log('[DEBUG] Processing raw LLM results to populate map...');
            const fieldTypeMap = new Map(fieldsForLLMCall.map(f => [f.identifier, f.type])); // Map cleaned id -> type

            for (const [rawKey, rawValue] of Object.entries(llmResults)) {
                 // Clean the key received from LLM
                 const cleanedKey = rawKey.replace(/\s*\*$/, '').trim();
                 console.log(`  [DEBUG] Processing rawKey: "${rawKey}", cleanedKey: "${cleanedKey}", rawValue:`, rawValue);
                 
                 // Check if this key corresponds to a field we asked about
                 if (fieldTypeMap.has(cleanedKey)) {
                     const expectedType = fieldTypeMap.get(cleanedKey);
                     let finalValue = rawValue; // Start with the raw value

                     // Apply multiselect correction if needed
                     if (expectedType === 'multiselect' && typeof rawValue === 'string' && rawValue.trim().length > 0) {
                         const potentialArray = rawValue.split(',').map(s => s.trim()).filter(Boolean);
                         if (potentialArray.length > 0) {
                             console.log(`    [DEBUG] Converted LLM string "${rawValue}" to array [${potentialArray.join(', ')}] for multiselect field "${cleanedKey}".`);
                             finalValue = potentialArray;
                         } else {
                             console.warn(`    [DEBUG] LLM string "${rawValue}" for multiselect field "${cleanedKey}" resulted in empty array after split, treating as null.`);
                             finalValue = null;
                         }
                     } 
                     // Add other type checks/corrections if necessary here

                     // Add to the map using the CLEANED key
                     console.log(`    [DEBUG] Adding to llmResponseMap: key="${cleanedKey}", value=`, finalValue);
                     llmResponseMap.set(cleanedKey, finalValue);
                 } else {
                      console.warn(`  [DEBUG] LLM returned key "${rawKey}" which does not match any requested field identifier (cleaned: "${cleanedKey}"). Ignoring.`);
                 }
            }
            // --- End Revised Logic ---

        } else {
            console.log("No fields needed LLM input based on initial scan.");
        }

        // Iterate through all fields identified in Pass 1/2
        for (const fieldRequest of fieldsToAskLLM) {
            const { identifier, type, isMandatory } = fieldRequest;
            
            // Skip if already handled (e.g., pre-filled, filled by profile in Pass 2)
            // NOTE: We re-find the locator even if handled, in case user prompt needs it, but skip LLM logic
            // const isAlreadyHandled = filledModalData.hasOwnProperty(identifier);
            // if (isAlreadyHandled) {
            //      console.log(`[Pass 3] Skipping LLM/User Prompt for "${identifier}", already handled.`);
            //      continue;
            // }

            // Get the LLM suggestion for this field (if any)
            const llmSuggestion = llmResponseMap.get(identifier); 
            
            console.log(`[DEBUG] Looking up identifier: "${identifier}"`);
            // console.log(`[DEBUG] LLM Response Map Keys:`, Array.from(llmResponseMap.keys())); // Too verbose
            console.log(`[DEBUG] Result from map.get("${identifier}"):`, llmSuggestion);
            let handled = false;
            // Re-check if already handled before proceeding to LLM/user prompt
            if (filledModalData.hasOwnProperty(identifier)) {
                 console.log(`[Pass 3] Field "${identifier}" was already handled (pre-filled/profile).`);
                 handled = true; // Mark as handled
            }
             
            if (!handled) { // Only proceed if not already handled
            console.log(`Handling LLM/User Prompt for: "${identifier}" (Type: ${type})${isMandatory ? ' [Mandatory]' : ''}`);

            // --- Check if suggestion exists --- 
            if (llmSuggestion !== null && llmSuggestion !== undefined) {
                 // ... (log suggestion) ...

                // --- Check for explicit NULL string --- 
                if (!Array.isArray(llmSuggestion) && String(llmSuggestion ?? '').toUpperCase() === 'NULL') {
                    console.log(`  LLM explicitly suggested NULL for field "${identifier}".`);
                    if (isMandatory && (type === 'select' || type === 'multiselect')) {
                        handled = await attemptFirstOptionFallback(fieldRequest, page, modal!, '[Fallback-NULL]');
                    } else if (isMandatory && type === 'text') {
                        // *** ADDED: Trigger N/A fallback for mandatory text on NULL ***
                        handled = await attemptTextNAFallback(fieldRequest, modal!, '[Fallback-NULL-Text]');
                        if (handled) filledModalData[identifier] = 'n/a'; // Update if fallback succeeded
                    } else if (!isMandatory) {
                         handled = true;
                         filledModalData[identifier] = null;
                         console.log(`  Adding to filledModalData (LLM NULL - Optional): { "${identifier}": null }`);
                    }
                
                } else { // --- Suggestion exists and is NOT the string "NULL" --- 
                    const freshLocator = await findFieldByLabel(modal!, identifier, type === 'checkbox' ? undefined : type);
                    if (!freshLocator) {
                        console.error(`\x1b[31m  [Pass 3] Could not re-find field for identifier "${identifier}". Skipping LLM application.\x1b[0m`);
                    } else {
                        console.log(`  [Pass 3] Successfully re-found locator for "${identifier}".`);
                        let applySuccess = false; 
                        try {
                            // --- Apply the actual suggestion --- 
                            if (type === 'checkbox') { /* ... apply logic ... */ } 
                            else if (type === 'select') { /* ... apply logic, set applySuccess ... */ } 
                            else if (type === 'multiselect') { /* ... apply logic, set applySuccess based on anyOptionClicked ... */ } 
                            else { /* text: apply logic, set applySuccess */ } 
                            // --- End applying suggestion ---

                            // --- Fallback if apply failed for mandatory select/multi --- 
                            if (!applySuccess && isMandatory && (type === 'select' || type === 'multiselect')) {
                                 handled = await attemptFirstOptionFallback(fieldRequest, page, modal!, '[Fallback-FailedSuggest]');
                            } else {
                                 handled = applySuccess;
                            }

                            // Update filledModalData only if handled and apply was successful
                            if (handled && applySuccess) { 
                                const valueToSave = llmSuggestion ?? null; 
                                if (valueToSave !== null) { 
                            console.log(`  Queueing profile update: { "${identifier}": ${JSON.stringify(valueToSave)} }`);
                            llmUpdates[identifier] = valueToSave; 
                                    }
                            console.log(`  Adding to filledModalData (LLM ${type}): { "${identifier}": ${JSON.stringify(valueToSave)} }`);
                            filledModalData[identifier] = valueToSave;
                        }
                            } catch (applyError) {
                                console.error(`\x1b[31m  Error applying LLM suggestion to "${identifier}":\x1b[0m`, applyError);
                                // Attempt fallback if mandatory select/multiselect failed due to error
                                if (isMandatory && (type === 'select' || type === 'multiselect')) {
                                     console.warn(`  Error during LLM suggestion application for mandatory ${type} "${identifier}". Attempting fallback.`);
                                     handled = await attemptFirstOptionFallback(fieldRequest, page, modal!, '[Fallback-Error]');
                                }
                            } // End catch applyError
                        } // End else block for freshLocator found
                    } // End else block for suggestion NOT NULL
                
                } // End if suggestion exists block
                else { // Suggestion IS null or undefined
                    console.log(`  LLM provided no suggestion for "${identifier}".`);
                    console.log(`[DEBUG] Fallback check for "${identifier}": Options available:`, fieldRequest.options);
                    if (isMandatory && (type === 'select' || type === 'multiselect')) {
                         // Mandatory select/multiselect with no suggestion -> Try fallback
                         handled = await attemptFirstOptionFallback(fieldRequest, page, modal!, '[Fallback-NoSuggest]');
                    } else if (isMandatory && type === 'text') {
                        // *** UPDATED: Trigger N/A fallback for mandatory text on null/undefined ***
                        handled = await attemptTextNAFallback(fieldRequest, modal!, '[Fallback-NoSuggest-Text]');
                        if (handled) filledModalData[identifier] = 'n/a'; // Update if fallback succeeded
                    } else {
                        // Optional field with no suggestion -> considered handled
                        handled = true;
                    }
                } // --- End Fallback block for missing suggestion ---

                // --- User Prompt Fallback (triggers if !handled and isMandatory) --- 
                if (!handled && isMandatory) {
                    console.log(`  Mandatory field "${identifier}" was not handled by LLM or fallback. Prompting user.`);
                    // ... (user prompt logic) ...
                }
            } // End if !handled

            // Short delay between processing fields 
            await page.waitForTimeout(250); // Increased slightly
        } // End loop through fieldsToProcess

        console.log('\n--- Finished processing modal fields ---');

        // --- Submit & Update Profile (Still inside main try block) --- 
        console.log('\nAttempting to submit form...');
        const submitButton = modal!.locator(submitButtonSelector).first(); // Use modal!
        if (await submitButton.isVisible() && await submitButton.isEnabled()) {
            await submitButton.click();
            console.log('Clicked modal submit button. Waiting for modal to close...');
            try {
                 await modal!.waitFor({ state: 'hidden', timeout: 7000 }); // Use modal!
                console.log('Modal closed. Submission presumed successful.');
                success = true; // Mark as successful
            } catch (closeError) {
                 console.error('\x1b[31mModal did not close after submitting. Submission might have failed.\x1b[0m');
            }
        } else {
            console.log('Could not find or interact with the modal submit button (hidden/disabled?).');
        }
    // --- End Main Try Block --- 
    } catch (popupError) {
        if (popupError instanceof Error && popupError.message?.includes('waitForSelector')) {
            console.log('No popup modal detected within timeout, or modal selector is incorrect.');
        } else {
            console.error('\x1b[31mError processing popup/form: [0m', popupError);
        }
        success = false; // Ensure success is false on error
    } finally {
        if (rl) {
            rl.close(); // Close rl if it was initialized
        }
    }
    
    // Return the collected data if successful, otherwise null
    return success ? filledModalData : null; 
} 