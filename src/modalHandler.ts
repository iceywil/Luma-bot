import { Page, Locator } from 'playwright';
import readline from 'readline/promises';
import { readProfile } from './config';
import { callLLMBatched, LLMFieldRequest as OriginalLLMFieldRequest } from './llm'; // Aliasing original
import { findFieldByLabel } from './domUtils';
import * as fs from 'fs/promises';

// Extend LLMFieldRequest to include isCustomTrigger
interface LLMFieldRequest extends OriginalLLMFieldRequest {
    isCustomTrigger?: boolean;
}

// --- Sanitization Helper ---
function sanitizeIdentifierForLLM(identifier: string): string {
    // Remove common emojis (this is a basic list, can be expanded)
    // Replace multiple spaces with single, trim, and remove trailing non-alphanumeric except ?
    // A more robust solution might involve a library or more extensive regex for all unicode emojis
    const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F018}\u{1F251}]/gu;
    let cleaned = identifier.replace(emojiRegex, '');
    // Remove or replace other problematic symbols, normalize spaces
    cleaned = cleaned.replace(/[^a-zA-Z0-9_\s\?\(\)\-\/\.:,]/g, ''); // Initial aggressive cleaning
    // Remove trailing non-alphanumeric characters (e.g., trailing ?, :, etc.) before final trim
    cleaned = cleaned.replace(/[^a-zA-Z0-9_\s\(\)]+$/g, '');
    cleaned = cleaned.replace(/\s+/g, ' ').trim(); // Consolidate multiple spaces and trim
    // console.log(`[Sanitize DEBUG] Original: "${identifier}" -> Cleaned: "${cleaned}"`);
    return cleaned;
}
// --- End Sanitization Helper ---

// --- Selectors (Modal Scope) ---
const modalSelector = 'div.lux-overlay.glass'; 
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

// --- Add Helper Function for Fallback --- 
async function attemptFirstOptionFallback(
    fieldRequest: LLMFieldRequest,
    page: Page,
    modal: Locator,
    logPrefix: string = '[Fallback]' // Allow customizing log prefix
): Promise<boolean> {
    const { identifier, type, isMandatory, options, locator, isCustomTrigger } = fieldRequest;
    if (!isMandatory || (type !== 'select' && type !== 'multiselect')) {
        // Should not be called in this case, but good safeguard
        return false; 
    }

    console.warn(`${logPrefix} Attempting fallback to first option for mandatory ${type} field "${identifier}".`);
    if (options && options.length > 0) {
        const firstOptionText = options[0];
        console.log(`${logPrefix} First available option: "${firstOptionText}". Attempting to select...`);
        
        let freshLocatorForFallback: Locator;
        if (isCustomTrigger) {
            console.log(`${logPrefix} Using direct locator for custom trigger field "${identifier}" in fallback.`);
            freshLocatorForFallback = locator; // Use the original locator passed in fieldRequest
        } else {
            console.log(`${logPrefix} Finding field "${identifier}" via label for fallback.`);
            const found = await findFieldByLabel(modal, identifier, type);
            if (!found) {
                console.error(`\x1b[31m ${logPrefix} Could not re-find field "${identifier}" (via label) to select first option.\x1b[0m`);
                return false;
            }
            freshLocatorForFallback = found;
        }

        try {
            await freshLocatorForFallback.waitFor({ state: 'visible', timeout: 5000 });
            const tagName = await freshLocatorForFallback.evaluate(el => el.tagName.toLowerCase());
            if (tagName === 'select') { // Standard select
                 await freshLocatorForFallback.selectOption({ label: firstOptionText }); 
                 console.log(`${logPrefix} Selected first option in standard select.`);
                 return true; // Success
            } else { // Custom select/multiselect (triggered by input, div, or span)
                 await freshLocatorForFallback.click({ timeout: 5000 }); 
                 await page.waitForTimeout(300);
                 let specificDropdownSelector = customSelectDropdownSelector;
                 const ariaControls = await freshLocatorForFallback.getAttribute('aria-controls');
                 if (ariaControls) specificDropdownSelector = `#${ariaControls}`;
                 const dropdown = page.locator(specificDropdownSelector).first();
                 await dropdown.waitFor({ state: 'visible', timeout: 5000 });
                 // Try exact match first, then starts-with for fallback
                 let optionToClick = dropdown.locator(`${customSelectOptionSelector}:has-text("${firstOptionText}")`).first();
                 if (!await optionToClick.isVisible({ timeout: 500 })) { // Quick check for exact match
                    console.log(`${logPrefix} Exact match for "${firstOptionText}" not immediately visible. Trying starts-with match.`);
                    optionToClick = dropdown.locator(`${customSelectOptionSelector}`).filter({ hasText: new RegExp(`^${firstOptionText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).first();
                 }

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
    console.warn(`${logPrefix} Mandatory text field "${identifier}" needs value. Attempting fallback to "n/a".`);
    const freshLocator = await findFieldByLabel(modal, identifier, type);
    if (!freshLocator) {
        console.error(`\x1b[31m ${logPrefix} Could not re-find field "${identifier}" to fill with "n/a".\x1b[0m`);
        return false;
    }
    try {
        await freshLocator.waitFor({ state: 'visible', timeout: 5000 });
        await freshLocator.fill('n/a');
        console.log(`${logPrefix} Filled text field "${identifier}" with "n/a".`);
        // Note: We don't update filledModalData here, let the calling function do it if needed
        return true; // Success
    } catch (textFallbackError) {
        console.error(`\x1b[31m ${logPrefix} Error filling text field "${identifier}" with "n/a":\x1b[0m`, textFallbackError);
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
        // Selector for spans that are DIRECTLY multiselect triggers (e.g. if the span itself is the main element)
        const specificSpanMultiSelectTriggerSelector = 'div.lux-menu-trigger-wrapper div.luma-input span';
        // Selector for DIVs that act as custom control triggers
        const divCustomControlTriggerSelector = 'div.lux-input'; // Based on user-provided HTML structure

        // Combine selectors
        const allFieldSelectors = [
            inputSelector,
            selectSelector,
            textareaSelector,
            specificSpanMultiSelectTriggerSelector, // For spans matched directly
            divCustomControlTriggerSelector      // For divs like div.lux-input
        ].join(', ');

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
            let textFromDirectSpanOrChildSpan = ''; // To store text from a span (either the field itself or a child of a div field)

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
                // If the field itself is a span, get its text content.
                textFromDirectSpanOrChildSpan = await field.textContent() || '';
            }
            
            // Initialize placeholderText with the input's attribute value by default.
            // It might be overridden if the field is a div with an inner placeholder span.
            let placeholderTextToUse = fieldPlaceholder;

            // --- Determine Field Type & Custom Trigger Status (Rewritten Logic) ---
            let fieldType: LLMFieldRequest['type'] | null = null; // Initialize to null
            let isCustomSelect = false; // Is it a custom trigger needing option extraction?
            let isFieldCustomTrigger = false; // To be passed to LLMFieldRequest
            
            if (tagName === 'select') {
                fieldType = 'select';
                isCustomSelect = false;
                isFieldCustomTrigger = false;
            } else if (tagName === 'textarea') {
                fieldType = 'text'; // Textareas are treated as text
                isCustomSelect = false;
                isFieldCustomTrigger = false;
            } else if (tagName === 'input') {
                const hasPopup = await field.getAttribute('aria-haspopup');
                // placeholderTextToUse is already fieldPlaceholder (from input attribute)
                console.log(`[Pass 1 DEBUG] Input aria-haspopup: "${hasPopup}", placeholder: "${placeholderTextToUse}"`); 
                
                if (hasPopup === 'listbox' || placeholderTextToUse === 'Select an option') {
                     const reason = hasPopup === 'listbox' ? 'aria-haspopup' : 'placeholder';
                     console.log(`[Pass 1 DEBUG] Input identified as Custom Select (Single) via ${reason}.`);
                     fieldType = 'select';
                     isCustomSelect = true;
                     isFieldCustomTrigger = true; // Mark as custom trigger
                 } else {
                     console.log(`[Pass 1 DEBUG] Input treated as text.`);
                     fieldType = 'text'; 
                     isCustomSelect = false;
                     isFieldCustomTrigger = false;
                 }
            } else if (tagName === 'span') {
                 // The field itself is a span. textFromDirectSpanOrChildSpan is already populated.
                 console.log(`[Pass 1 DEBUG] Evaluating SPAN element (field itself). Raw spanText: "${textFromDirectSpanOrChildSpan}", Lowercase spanText: "${textFromDirectSpanOrChildSpan.toLowerCase()}"`);
                 console.log(`[Pass 1 DEBUG] Current specificSpanMultiSelectTriggerSelector: "${specificSpanMultiSelectTriggerSelector}"`);
                 
                 if (await field.evaluate((el, selector) => el.matches(selector), specificSpanMultiSelectTriggerSelector) ||
                     textFromDirectSpanOrChildSpan.toLowerCase().includes("select one or more") || 
                     textFromDirectSpanOrChildSpan.toLowerCase().includes("choose options")) {
                     console.log(`[Pass 1 DEBUG] Span (field itself) identified as Multi-Select trigger via specific CSS selector or text content: "${textFromDirectSpanOrChildSpan}"`);
                     fieldType = 'multiselect'; 
                     isCustomSelect = true;
                     isFieldCustomTrigger = true; // Mark as custom trigger
                 } else {
                     console.log(`[Pass 1 DEBUG] Skipping unhandled span (field itself) with text content: "${textFromDirectSpanOrChildSpan}" (did not match multi-select criteria).`);
                     continue; 
                 }
            } else if (tagName === 'div') {
                // Check if this div is one of our designated custom control triggers (e.g., div.lux-input)
                if (await field.evaluate((el, selector) => el.matches(selector), divCustomControlTriggerSelector)) {
                    const innerSpan = field.locator('span.placeholder').first(); // Look for the specific child span
                    if (await innerSpan.isVisible({ timeout: 100 })) { // Increased timeout slightly
                        textFromDirectSpanOrChildSpan = (await innerSpan.textContent() || '').trim();
                        placeholderTextToUse = textFromDirectSpanOrChildSpan; // CRITICAL: Use inner span's text as the placeholder for identifier

                        if (textFromDirectSpanOrChildSpan.toLowerCase().includes("select one or more") || textFromDirectSpanOrChildSpan.toLowerCase().includes("choose options")) {
                            console.log(`[Pass 1 DEBUG] Div (field itself, e.g., div.lux-input) with inner span text "${textFromDirectSpanOrChildSpan}" identified as Multi-Select trigger.`);
                            fieldType = 'multiselect';
                            isCustomSelect = true; // The div (field) is the click trigger
                            isFieldCustomTrigger = true; // Mark as custom trigger
                        } else if (textFromDirectSpanOrChildSpan.toLowerCase().includes("select an option")) {
                            console.log(`[Pass 1 DEBUG] Div (field itself, e.g., div.lux-input) with inner span text "${textFromDirectSpanOrChildSpan}" identified as Custom Select (Single) trigger.`);
                            fieldType = 'select';
                            isCustomSelect = true; // The div (field) is the click trigger
                            isFieldCustomTrigger = true; // Mark as custom trigger
                        } else {
                            console.log(`[Pass 1 DEBUG] Div (field itself, e.g., div.lux-input) with inner span text "${textFromDirectSpanOrChildSpan}" not recognized as select/multiselect. Skipping.`);
                            continue;
                        }
                    } else {
                        console.log(`[Pass 1 DEBUG] Div (field itself, e.g., div.lux-input) does not have a visible 'span.placeholder' child. Skipping.`);
                        continue;
                    }
                } else {
                    console.log(`[Pass 1 DEBUG] Skipping div that doesn't match "${divCustomControlTriggerSelector}". Tag: ${tagName}`);
                    continue;
                }
            } else {
                 console.log(`[Pass 1 DEBUG] Skipping element with unhandled tag: ${tagName} (not input, select, textarea, handled span, or handled div).`);
                 continue; // Skip this iteration of the loop
            }

            if (fieldType === null) {
                console.warn(`[Pass 1 DEBUG] Field type could not be determined for element (Tag: ${tagName}, Label: ${labelText.trim()}, Placeholder: ${placeholderTextToUse}). Skipping.`);
                 continue;
            }
            
            // Determine the primary identifier text for the field.
            // Prefer labelText. If not available, use placeholderTextToUse (which could be from input attribute or inner span of a div).
            // If field is a span and still no identifier, use its own text.
            let bestIdentifierText = labelText.trim() || placeholderTextToUse?.trim() || (tagName === 'span' ? textFromDirectSpanOrChildSpan.trim() : '');
            let rawIdentifier = bestIdentifierText || fieldName || `field_${i}`; // Add fieldName as a fallback before generic field_i

            const isMandatoryField = rawIdentifier.trim().endsWith('*'); // Renamed from isMandatory to avoid conflict
            const fieldIdentifier = rawIdentifier.replace(/\s*\*$/, '').trim();
            const sanitizedIdentifier = sanitizeIdentifierForLLM(fieldIdentifier); // Sanitize here

            console.log(`[Pass 1 DEBUG] Field Details: Index=${i}, Tag="${tagName}", FieldID="${fieldId}", Name="${fieldName}", Label="${labelText.trim()}", InputPlaceholder="${fieldPlaceholder}", ExtractedSpanText="${textFromDirectSpanOrChildSpan}", EffectivePlaceholder="${placeholderTextToUse}", RawIdentifier="${fieldIdentifier}", SanitizedIdentifier="${sanitizedIdentifier}"`);
            console.log(`Processing Field: "${sanitizedIdentifier}" (Tag: ${tagName}, Determined Type: ${fieldType})${isMandatoryField ? ' [Mandatory]' : ''}${isCustomSelect ? ' [Custom Select Trigger]' : ''}`);

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
                    console.log(`  Adding to filledModalData (pre-filled): { "${sanitizedIdentifier}": "${currentValue}" }`);
                    filledModalData[sanitizedIdentifier] = currentValue;
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
                    key.toLowerCase() === sanitizedIdentifier.toLowerCase() ||
                    key.toLowerCase() === fieldName?.toLowerCase()
                );
                if (profileKey) {
                    valueToFill = profileData[profileKey];
                    console.log(`  Found in profile: "${profileKey}" = "${valueToFill}".`);
                    try {
                        if (typeof valueToFill === 'string') {
                            await field.fill(valueToFill);
                            console.log(`  Filled text input from profile.`);
                            console.log(`  Adding to filledModalData (profile): { "${sanitizedIdentifier}": "${valueToFill}" }`);
                            filledModalData[sanitizedIdentifier] = valueToFill;
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
                          const filename = `option_extract_fail_${sanitizedIdentifier.replace(/[^a-z0-9]/gi, '')}_${Date.now()}.html`;
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
                console.log(`  Adding to LLM batch (Using Sanitized ID: "${sanitizedIdentifier}").`);
                fieldsToAskLLM.push({ 
                    identifier: sanitizedIdentifier, 
                    type: fieldType, 
                    options, 
                    locator: field, 
                    isMandatory: isMandatoryField,  // Use renamed variable
                    isCustomTrigger: isFieldCustomTrigger // Add the new flag
                }); 
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
            let cleanCheckboxLabelText = rawCheckboxLabel.replace(/\s*\*$/, '').trim(); // Human-readable label
            const sanitizedCheckboxIdentifier = sanitizeIdentifierForLLM(cleanCheckboxLabelText); // Sanitize

            console.log(`Processing Checkbox (Modal): "${cleanCheckboxLabelText}" (Sanitized: "${sanitizedCheckboxIdentifier}")${isMandatory ? ' [Mandatory]' : ''}`);

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
                        console.log(`  Adding to filledModalData (mandatory checkbox): { "${sanitizedCheckboxIdentifier}": "Yes" }`);
                        filledModalData[sanitizedCheckboxIdentifier] = 'Yes'; // Use sanitized ID
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
                                 console.log(`  Adding to filledModalData (mandatory checkbox via terms): { "${sanitizedCheckboxIdentifier}": "Yes" }`);
                                 filledModalData[sanitizedCheckboxIdentifier] = 'Yes'; // Use sanitized ID
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
                fieldsToAskLLM.push({ identifier: sanitizedCheckboxIdentifier, type: 'checkbox', locator: clickTarget, isMandatory }); // Use sanitized ID
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

            for (const [rawKeyFromLLM, rawValue] of Object.entries(llmResults)) {
                 // Sanitize the key received from LLM using the same logic
                 const sanitizedKeyFromLLM = sanitizeIdentifierForLLM(rawKeyFromLLM);
                 console.log(`  [DEBUG] Processing rawKeyFromLLM: "${rawKeyFromLLM}", sanitizedKeyFromLLM: "${sanitizedKeyFromLLM}", rawValue:`, rawValue);
                 
                 // Check if this sanitized key corresponds to a field we asked about (which also has a sanitized ID)
                 if (fieldTypeMap.has(sanitizedKeyFromLLM)) {
                     const expectedType = fieldTypeMap.get(sanitizedKeyFromLLM);
                     let finalValue = rawValue;

                     if (expectedType === 'multiselect' && typeof rawValue === 'string' && rawValue.trim().length > 0) {
                         const potentialArray = rawValue.split(',').map(s => s.trim()).filter(Boolean);
                         if (potentialArray.length > 0) {
                             console.log(`    [DEBUG] Converted LLM string "${rawValue}" to array [${potentialArray.join(', ')}] for multiselect field "${sanitizedKeyFromLLM}".`);
                             finalValue = potentialArray;
                         } else {
                             console.warn(`    [DEBUG] LLM string "${rawValue}" for multiselect field "${sanitizedKeyFromLLM}" resulted in empty array after split, treating as null.`);
                             finalValue = null;
                         }
                     } 
                     // Add other type checks/corrections if necessary here

                     // Add to the map using the CLEANED key
                     console.log(`    [DEBUG] Adding to llmResponseMap: key="${sanitizedKeyFromLLM}", value=`, finalValue);
                     llmResponseMap.set(sanitizedKeyFromLLM, finalValue);
                 } else {
                      console.warn(`  [DEBUG] LLM returned key "${rawKeyFromLLM}" (sanitized: "${sanitizedKeyFromLLM}") which does not match any requested (sanitized) field identifier. Ignoring.`);
                 }
            }
            // --- End Revised Logic ---

        } else {
            console.log("No fields needed LLM input based on initial scan.");
        }

        // Iterate through all fields identified in Pass 1/2
        for (const fieldRequest of fieldsToAskLLM) {
            const { identifier, type, isMandatory, locator, isCustomTrigger } = fieldRequest; // Include isCustomTrigger
            
            const llmSuggestion = llmResponseMap.get(identifier); // Look up using sanitized identifier
            
            console.log(`[DEBUG] Looking up (sanitized) identifier: "${identifier}" in llmResponseMap.`);
            console.log(`[DEBUG] Result from map.get("${identifier}"):`, llmSuggestion);
            let handled = false;
            // Re-check if already handled before proceeding to LLM/user prompt
            if (filledModalData.hasOwnProperty(identifier)) {
                 console.log(`[Pass 3] Field "${identifier}" was already handled (pre-filled/profile/mandatory checkbox).`);
                 handled = true; // Mark as handled
            }
             
            if (!handled) { // Only proceed if not already handled
            console.log(`Handling LLM/User Prompt for: "${identifier}" (Type: ${type})${isMandatory ? ' [Mandatory]' : ''}`);

            // --- Check if suggestion exists --- 
            if (llmSuggestion !== null && llmSuggestion !== undefined) {

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
                    // const freshLocator = await findFieldByLabel(modal!, identifier, type === 'checkbox' ? undefined : type);
                    
                    let freshLocator: Locator | null;
                    // const originalFieldTag = await fieldRequest.locator.evaluate(el => el.tagName.toLowerCase()); // Already have locator. This line was causing a lint error, so it's commented out or removed if not needed.

                    if (isCustomTrigger) { // Check the flag from LLMFieldRequest
                        console.log(`  [Pass 3] Using direct locator for custom trigger field "${identifier}".`);
                        freshLocator = locator; // Use the locator stored in fieldRequest
                    } else {
                        console.log(`  [Pass 3] Attempting to find field via label for: "${identifier}" (type: ${type}).`);
                        freshLocator = await findFieldByLabel(modal!, identifier, type === 'checkbox' ? undefined : type);
                    }

                    if (!freshLocator) {
                        console.error(`\x1b[31m  [Pass 3] Could not obtain locator for field "${identifier}". Skipping LLM application.\x1b[0m`);
                    } else {
                        // Only log "Successfully re-found" if we actually used findFieldByLabel and it was not a custom trigger handled by direct locator
                        if (!isCustomTrigger) { 
                             console.log(`  [Pass 3] Successfully re-found locator for "${identifier}" via findFieldByLabel.`);
                        }
                        // console.log(`  [Pass 3] Successfully re-found locator for "${identifier}".`); // Old log
                        let applySuccess = false; 
                        try {
                            // --- Apply the actual suggestion --- 
                            if (type === 'checkbox') {
                                console.log(`  Attempting to set checkbox "${identifier}" based on LLM value: "${llmSuggestion}"`);
                                const clickTargetLocator = locator; // This is fieldRequest.locator, the clickable element
                                
                                // Find the actual input relative to the click target's container
                                const checkboxContainerLocator = clickTargetLocator.locator('xpath=./ancestor::div[contains(@class, "lux-checkbox")]').first();
                                const actualCheckboxInput = checkboxContainerLocator.locator('input[type="checkbox"]').first();

                                if (!actualCheckboxInput || !await actualCheckboxInput.isVisible({ timeout: 1000 })) {
                                    console.warn(`    Checkbox input for "${identifier}" not found or not visible relative to its click target. Skipping.`);
                                    applySuccess = false;
                                } else {
                                    const currentState = await actualCheckboxInput.isChecked();
                                    const desireStateIsChecked = String(llmSuggestion).toLowerCase() === 'yes' || String(llmSuggestion).toLowerCase() === 'true';

                                    if (currentState !== desireStateIsChecked) {
                                        console.log(`    Checkbox state is ${currentState}, desired is ${desireStateIsChecked}. Clicking designated click target.`);
                                        if (!clickTargetLocator) {
                                            console.error(`    ERROR: clickTargetLocator is null for checkbox "${identifier}". Cannot click.`);
                                            applySuccess = false;
                                        } else {
                                            await clickTargetLocator.click({ timeout: 5000 });
                                            await page.waitForTimeout(300); // Wait for state to potentially update
                                            const newState = await actualCheckboxInput.isChecked();
                                            if (newState === desireStateIsChecked) {
                                                console.log(`    Checkbox "${identifier}" successfully set to ${desireStateIsChecked}.`);
                                                applySuccess = true;
                                            } else {
                                                console.warn(`    Clicked checkbox target for "${identifier}", but state did not change as expected. Current: ${newState}, Desired: ${desireStateIsChecked}`);
                                                applySuccess = false;
                                            }
                                        }
                                    } else {
                                        console.log(`    Checkbox "${identifier}" is already in the desired state (${currentState}).`);
                                        applySuccess = true; // Already correct
                                    }
                                }
                            } 
                            else if (type === 'select') {
                                console.log(`  Attempting to select option for "${identifier}" with LLM value: "${llmSuggestion}"`);
                                const suggestedOption = String(llmSuggestion);
                                const tagName = await freshLocator.evaluate(el => el.tagName.toLowerCase());

                                if (tagName === 'select') { // Standard select
                                    try {
                                        const optionLocatorValue = freshLocator.locator(`option[value="${suggestedOption}"]`);
                                        const optionLocatorText = freshLocator.locator(`option`).filter({ hasText: new RegExp(`^${suggestedOption.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')});
                                        
                                        if (await optionLocatorValue.count() > 0) {
                                            await freshLocator.selectOption({ value: suggestedOption });
                                            console.log(`    Selected option by value "${suggestedOption}" in standard select "${identifier}".`);
                                            applySuccess = true;
                                        } else if (await optionLocatorText.count() > 0) {
                                            await freshLocator.selectOption({ label: suggestedOption });
                                            console.log(`    Selected option by label "${suggestedOption}" in standard select "${identifier}".`);
                                            applySuccess = true;
                                        } else {
                                            const availableOptions = await freshLocator.locator('option').evaluateAll(opts => opts.map(o => ({ value: (o as HTMLOptionElement).value, text: o.textContent?.trim() })));
                                            console.warn(`    Option "${suggestedOption}" not found in standard select "${identifier}". Available: ${JSON.stringify(availableOptions)}`);
                                            applySuccess = false;
                                        }
                                    } catch (e) {
                                        console.error(`    Error selecting option in standard select "${identifier}":`, e);
                                        applySuccess = false;
                                    }
                                } else { // Custom select (freshLocator is the trigger)
                                    try {
                                        await freshLocator.click({ timeout: 5000 });
                                        await page.waitForTimeout(500); // Wait for dropdown to appear

                                        let dropdown: Locator;
                                        const ariaControlsId = await freshLocator.getAttribute('aria-controls');
                                        if (ariaControlsId) {
                                            dropdown = page.locator(`#${ariaControlsId.trim()}`);
                                            console.log(`    Custom select dropdown identified by aria-controls: #${ariaControlsId.trim()}`);
                                        } else {
                                            console.log(`    No aria-controls for custom select. Locating first general dropdown: ${customSelectDropdownSelector} and will wait for visibility.`);
                                            dropdown = page.locator(customSelectDropdownSelector).first(); // Locate the first one
                                        }
                                        await dropdown.waitFor({ state: 'visible', timeout: 5000 }); // Wait for it to be visible

                                        // Try exact match first, then starts-with for LLM suggestion
                                        let optionToClick = dropdown.locator(`${customSelectOptionSelector}`).filter({ hasText: new RegExp(`^${suggestedOption.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).first();
                                        if (!await optionToClick.isVisible({ timeout: 500 })) { // Quick check for exact match
                                            console.log(`    Exact match for LLM suggestion "${suggestedOption}" not immediately visible. Trying starts-with match.`);
                                            optionToClick = dropdown.locator(`${customSelectOptionSelector}`).filter({ hasText: new RegExp(`^${suggestedOption.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i') }).first(); // Starts with
                                        }
                                        
                                        if (await optionToClick.isVisible({ timeout: 2000 })) {
                                            await optionToClick.click({ timeout: 5000 });
                                            console.log(`    Clicked option "${suggestedOption}" (or similar) in custom select "${identifier}".`);
                                            applySuccess = true;
                                            try {
                                                await page.locator('body').click({ position: { x: 0, y: 0 }, delay: 100, force: true });
                                                await dropdown.waitFor({ state: 'hidden', timeout: 2000 });
                                            } catch { console.warn(`    Could not confirm custom select dropdown for "${identifier}" closed.`); }
                                        } else {
                                            const availableOptions = await dropdown.locator(customSelectOptionSelector).allTextContents();
                                            console.warn(`    Option "${suggestedOption}" not visible in custom select "${identifier}". Available: [${availableOptions.join(', ')}]`);
                                            applySuccess = false;
                                            try { await page.locator('body').click({ position: { x: 0, y: 0 }, delay: 100, force: true }); } catch {}
                                        }
                                    } catch (e) {
                                        console.error(`    Error interacting with custom select "${identifier}":`, e);
                                        applySuccess = false;
                                        try { await page.locator('body').click({ position: { x: 0, y: 0 }, delay: 100, force: true }); } catch {}
                                    }
                                }
                            } 
                            else if (type === 'multiselect') {
                                console.log(`  Attempting to select options for multiselect "${identifier}" with LLM values: "${llmSuggestion}"`);
                                if (Array.isArray(llmSuggestion) && llmSuggestion.length > 0) {
                                    let anyOptionClicked = false;
                                    try {
                                        await freshLocator.click({ timeout: 5000 }); // Open dropdown
                                        await page.waitForTimeout(500);

                                        let dropdown: Locator;
                                        const ariaControlsId = await freshLocator.getAttribute('aria-controls');
                                        if (ariaControlsId) {
                                            dropdown = page.locator(`#${ariaControlsId.trim()}`);
                                            console.log(`    Multiselect dropdown identified by aria-controls: #${ariaControlsId.trim()}`);
                                        } else {
                                            console.log(`    No aria-controls for multiselect. Locating first general dropdown: ${customSelectDropdownSelector} and will wait for visibility.`);
                                            dropdown = page.locator(customSelectDropdownSelector).first(); // Locate the first one
                                        }
                                        await dropdown.waitFor({ state: 'visible', timeout: 5000 }); // Wait for it to be visible

                                        for (const optionText of llmSuggestion) {
                                            if (typeof optionText !== 'string') {
                                                console.warn(`    Skipping non-string option in multiselect: ${optionText}`);
                                                continue;
                                            }
                                            // Try exact match first, then starts-with for LLM suggestion
                                            let optionToClick = dropdown.locator(`${customSelectOptionSelector}`).filter({ hasText: new RegExp(`^${optionText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).first();
                                            if (!await optionToClick.isVisible({ timeout: 500 })) { // Quick check for exact match
                                                console.log(`    Exact match for LLM multiselect option "${optionText}" not immediately visible. Trying starts-with match.`);
                                                optionToClick = dropdown.locator(`${customSelectOptionSelector}`).filter({ hasText: new RegExp(`^${optionText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i') }).first(); // Starts with
                                            }

                                            if (await optionToClick.isVisible({ timeout: 1000 })) {
                                                await optionToClick.click({ timeout: 5000 });
                                                console.log(`    Clicked option "${optionText}" (or similar) in multiselect "${identifier}".`);
                                                anyOptionClicked = true;
                                                await page.waitForTimeout(150); // Small pause between clicks
                                            } else {
                                                console.warn(`    Option "${optionText}" not visible in multiselect "${identifier}".`);
                                            }
                                        }
                                        applySuccess = anyOptionClicked;
                                        try {
                                            await page.locator('body').click({ position: { x: 0, y: 0 }, delay: 100, force: true });
                                            await dropdown.waitFor({ state: 'hidden', timeout: 2000 });
                                        } catch { console.warn(`    Could not confirm multiselect dropdown for "${identifier}" closed.`); }
                                    } catch (e) {
                                        console.error(`    Error interacting with multiselect "${identifier}":`, e);
                                        applySuccess = false;
                                        try { await page.locator('body').click({ position: { x: 0, y: 0 }, delay: 100, force: true }); } catch {}
                                    }
                                } else {
                                    console.log(`    LLM suggestion for multiselect "${identifier}" is not a non-empty array or is missing. Suggestion: ${JSON.stringify(llmSuggestion)}`);
                                    applySuccess = false;
                                }
                            } 
                            else { // Handles 'text' and 'textarea'
                                console.log(`  Attempting to fill ${type} field "${identifier}" with LLM value: "${llmSuggestion}"`);
                                if (llmSuggestion !== null && llmSuggestion !== undefined) {
                                    await freshLocator.fill(String(llmSuggestion));
                                    applySuccess = true;
                                    console.log(`    Successfully filled ${type} field "${identifier}". applySuccess: true`);
                                } else {
                                    console.log(`    LLM suggestion for ${type} field "${identifier}" is null or undefined. Not filling. applySuccess: false`);
                                    applySuccess = false; // Explicitly false if suggestion is null/undefined
                                }
                            } 
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