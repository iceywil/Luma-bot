import { chromium, Locator } from 'playwright';
import * as fs from 'fs/promises';
import * as path from 'path';
import { processEvent } from "./eventProcessor";

// --- Config ---
const eventUrl = 'https://luma.com/UnchainedSummitDubai'; // Use the URL from the web search result
const registerButtonSelector = 'button:has-text("Request to Join")'; 
// ** UPDATED HYPOTHETICAL SELECTORS - VERIFY THESE **
const dropdownSelector = 'div.lux-menu'; // Try common Luma menu class
const optionSelector = 'div.lux-menu-item'; // Try common Luma menu item class
const submitButtonSelector = 'button:has-text("Submit")'; // Added submit button selector

// --- Helper to check if an input acts like a select (copied from modalHandler) ---
function isCustomSelectTrigger(tagName: string, identifier: string, placeholder: string | null): boolean {
    if (tagName !== 'input') return false;
    const lowerIdentifier = identifier.toLowerCase();
    const lowerPlaceholder = placeholder?.toLowerCase() || '';
    // Add more keywords if needed
    return lowerIdentifier.includes('select') || 
           lowerIdentifier.includes('choose') || 
           lowerIdentifier.includes('type') || 
           lowerIdentifier.includes('role') || 
           lowerPlaceholder.includes('select') || 
           lowerPlaceholder.includes('sélectionnez') || 
           lowerPlaceholder.includes('choose'); 
}

async function debugSelect() {
    console.log('Launching browser...');
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext(); 
    const page = await context.newPage();

    try {
        console.log(`Navigating to: ${eventUrl}`);
        await page.goto(eventUrl, { waitUntil: 'networkidle' });

        console.log('Clicking main registration button...');
        const registerButton = page.locator(registerButtonSelector).first();
        await registerButton.click({ timeout: 20000 });

        console.log('Waiting for modal overlay...');
        const modalSelector = 'div.lux-overlay.glass'; 
        const modal = page.locator(modalSelector);
        await modal.waitFor({ state: 'visible', timeout: 15000 });
        console.log('Modal detected.');
        

        console.log('Searching for form fields within modal...');
        // Use the broader selector from modalHandler to include select/textarea/span
        const inputSelector = 'input:not([type="hidden"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"])';
        const selectSelector = 'select';
        const textareaSelector = 'textarea';
        const spanTriggerSelector = 'span[role="button"]'; // Placeholder
        const divTriggerSelector = 'div.lux-menu-trigger-wrapper'; // Add the div wrapper
        // Combine selectors
        const allFieldSelectors = [inputSelector, selectSelector, textareaSelector, spanTriggerSelector, divTriggerSelector].join(', ');
        
        const fields = modal.locator(allFieldSelectors);
        const fieldCount = await fields.count();
        console.log(`Found ${fieldCount} potential field(s) to check.`);
        let targetSelectTrigger: Locator | null = null;
        let targetSelectLabel: Locator | null = null;
        let identifiedFieldType: string = 'text'; // Store the type of the *last* identified trigger
        let isLikelyMultiSelect = false; // Flag if the *last* identified trigger seems multi-select

        for (let i = 0; i < fieldCount; i++) {
            const field = fields.nth(i);
            const tagName = await field.evaluate(el => el.tagName.toLowerCase());
            const fieldId = await field.getAttribute('id');
            const fieldName = await field.getAttribute('name');
            const fieldTypeAttr = await field.getAttribute('type'); // Renamed from fieldType to avoid conflict
            const fieldPlaceholder = await field.getAttribute('placeholder');
            let labelText = '';
            let spanText = '';
            let placeholderText = fieldPlaceholder; // Use input placeholder by default
            let labelLocator: Locator | null = null;

            // --- Label Finding Logic (more robust) ---
            // Try direct `for` attribute
            if (fieldId) {
                labelLocator = modal.locator(`label[for="${fieldId}"]`).first();
                if (await labelLocator.isVisible({timeout:50})) {
                   labelText = await labelLocator.textContent() || '';
                } 
            }
            // Try complex XPath if no direct label (or if it's a div/span)
            if (!labelText) {
                 try {
                     const complexLabel = await field.locator('xpath=./ancestor::*[normalize-space(./label/text())][1]/label | ./preceding-sibling::label | ./ancestor::*[label][1]/label').first();
                     if (await complexLabel.isVisible({timeout: 50})){
                          labelText = await complexLabel.textContent() || '';
                     }
                 } catch (e) {/* ignore */} 
            }
            // --- End Label Finding --- 
            
            // --- Get Specific Text for Spans/Divs ---
            if (tagName === 'span') {
                spanText = await field.textContent() || '';
            } else if (tagName === 'div' && await field.evaluate(el => el.matches('div.lux-menu-trigger-wrapper'))) {
                // For the div trigger, try to find the inner placeholder span text
                const innerPlaceholder = field.locator('span.placeholder').first();
                if (await innerPlaceholder.isVisible({timeout: 50})) {
                    placeholderText = await innerPlaceholder.textContent() || fieldPlaceholder; // Use inner text, fallback to attribute
                }
            }
            
            const rawIdentifier = labelText.trim() || fieldName || placeholderText?.trim() || spanText.trim() || `field_${i}`;
            const fieldIdentifier = rawIdentifier.replace(/\s*\*$/, '').trim();

            console.log(`-- Field #${i}: Tag="${tagName}", ID="${fieldId}", Name="${fieldName}", TypeAttr="${fieldTypeAttr}", Placeholder="${placeholderText}", Label="${labelText.trim()}", SpanText="${spanText.trim()}", Identifier="${fieldIdentifier}"`);

            let isCurrentFieldSelectTrigger = false;
            let currentFieldType: string = 'text';
            let isCurrentFieldMultiSelect = false;

            if (tagName === 'input') {
                 // Replace placeholder check with structural check
                 const isInsideTriggerWrapper = await field.evaluate((el) => {
                     const parent = el.parentElement;
                     const grandParent = parent?.parentElement;
                     const wrapperSelector = 'div.lux-menu-trigger-wrapper'; // Use the known wrapper selector
                     return parent?.matches(wrapperSelector) || grandParent?.matches(wrapperSelector);
                 });

                 if (isInsideTriggerWrapper) {
                     console.log(`   ^^^ Input #${i} identified as potential custom select trigger (Single Select via wrapper) ^^^`);
                     isCurrentFieldSelectTrigger = true;
                     currentFieldType = 'select';
                 } else {
                     // Assume regular text input if not inside the wrapper
                     currentFieldType = 'text';
                 }
            } else if (tagName === 'span' && await field.evaluate(el => el.matches('span[role="button"]'))) { // Pass selector string directly
                 const lowerIdentifier = fieldIdentifier.toLowerCase();
                 if (lowerIdentifier.includes('select') || lowerIdentifier.includes('choose') || lowerIdentifier.includes('type') || lowerIdentifier.includes('role') || lowerIdentifier.includes('sectors') ) {
                     isCurrentFieldSelectTrigger = true;
                     if (lowerIdentifier.includes('sectors') || lowerIdentifier.includes('multiple')) {
                         isCurrentFieldMultiSelect = true;
                         currentFieldType = 'multiselect';
                     } else {
                          currentFieldType = 'select';
                     }
                 }
            } else if (tagName === 'div' && await field.evaluate(el => el.matches('div.lux-menu-trigger-wrapper'))) { // Pass selector string directly
                const lowerIdentifier = fieldIdentifier.toLowerCase();
                // Check identifier (label) or placeholder text from inner span
                if (lowerIdentifier.includes('select') || lowerIdentifier.includes('choose') || lowerIdentifier.includes('type') || lowerIdentifier.includes('role') || lowerIdentifier.includes('sectors') ) {
                    console.log(`[DEBUG] Div trigger identified as potential select/multiselect.`);
                    isCurrentFieldSelectTrigger = true;
                    if (lowerIdentifier.includes('sectors') || lowerIdentifier.includes('multiple') || placeholderText?.toLowerCase().includes('one or more')) {
                        isCurrentFieldMultiSelect = true;
                        currentFieldType = 'multiselect';
                    } else {
                         currentFieldType = 'select';
                    }
                 }
            } else if (tagName === 'select') {
                 currentFieldType = 'select'; // Standard select
             } else if (tagName === 'textarea') {
                 currentFieldType = 'text';
             }

            if (isCurrentFieldSelectTrigger) {
                 console.log(`   ^^^ Field #${i} identified as potential custom select/multiselect trigger (Type: ${currentFieldType}) ^^^`);
                 targetSelectTrigger = field; // Keep track of the last identified trigger
                 identifiedFieldType = currentFieldType;
                 isLikelyMultiSelect = isCurrentFieldMultiSelect;
                 if (labelLocator && await labelLocator.count() > 0) {
                     targetSelectLabel = labelLocator;
                 }
            }
        }

        if (!targetSelectTrigger) {
             throw new Error('Could not find any element identified as a custom select trigger in the modal.');
        }
        
        // --- Debug the final click target ---
        const finalTriggerTagName = await targetSelectTrigger.evaluate(el => el.tagName.toLowerCase());
        const finalTriggerId = await targetSelectTrigger.getAttribute('id');
        console.log(`[DEBUG] Final target trigger details before click: Tag="${finalTriggerTagName}", ID="${finalTriggerId}"`);
        if (targetSelectLabel) {
             const finalLabelText = await targetSelectLabel.textContent() || '';
             console.log(`[DEBUG] Using Label as click target: Text="${finalLabelText.trim()}"`);
        } else {
             console.log(`[DEBUG] Using Field element as click target.`);
        }
        // --- End Debug ---

        console.log(`Clicking the last identified trigger (Type: ${identifiedFieldType}, MultiSelectGuess: ${isLikelyMultiSelect})`);
        const clickTarget = targetSelectLabel || targetSelectTrigger;
        await clickTarget.click({ timeout: 5000 });
        
        await page.waitForTimeout(300); 

        // --- Try to find dropdown via aria-controls for specificity ---
        let specificDropdownSelector = dropdownSelector; // Default to generic
        const ariaControls = await clickTarget.getAttribute('aria-controls');
        if (ariaControls) {
            specificDropdownSelector = `#${ariaControls}`;
            console.log(`[DEBUG] Found aria-controls="${ariaControls}". Using specific dropdown selector: ${specificDropdownSelector}`);
        } else {
             console.warn(`[DEBUG] No aria-controls found on trigger. Falling back to generic dropdown selector: ${dropdownSelector}`);
        }
        // --- End aria-controls logic ---

        let fullHtml = ''; 
        try {
            console.log(`Waiting for dropdown menu using selector: ${specificDropdownSelector}...`);
            // Use page locator as dropdown might be outside modal/trigger context
            const dropdown = page.locator(specificDropdownSelector).first(); 
            await dropdown.waitFor({ state: 'visible', timeout: 5000 });
            console.log('Dropdown menu appeared!');

            console.log(`Extracting options using selector: ${optionSelector}...`);
            const options = await dropdown.locator(optionSelector).allTextContents();
            const cleanedOptions = options.map(o => o.trim()).filter(Boolean);
            console.log('Extracted Options:', cleanedOptions);

            // --- Attempt multi-select simulation if flagged ---
            if (isLikelyMultiSelect && cleanedOptions.length >= 2) {
                console.log('--- Testing Multi-Select Clicks --- ');
                const firstOptionText = cleanedOptions[0];
                const secondOptionText = cleanedOptions[1];
                
                // Click First Option
                console.log(`  Attempting to click first option: "${firstOptionText}"`);
                try {
                    const firstOptionLocator = dropdown.locator(`${optionSelector}:has-text("${firstOptionText}")`).first();
                    await firstOptionLocator.click({ timeout: 3000 });
                    console.log('    Successfully clicked first option.');
                } catch (clickError) {
                    console.error(`    Failed to click first option ("${firstOptionText}"):`, clickError);
                }

                await page.waitForTimeout(500); // Pause between clicks

                // Click Second Option (re-check visibility/locate)
                 console.log(`  Attempting to click second option: "${secondOptionText}"`);
                 try {
                     // Re-check dropdown visibility
                     await dropdown.waitFor({ state: 'visible', timeout: 3000 }); 
                     const secondOptionLocator = dropdown.locator(`${optionSelector}:has-text("${secondOptionText}")`).first();
                     await secondOptionLocator.click({ timeout: 3000 });
                     console.log('    Successfully clicked second option.');
                 } catch (clickError) {
                     console.error(`    Failed to click second option ("${secondOptionText}"):`, clickError);
                 }
                console.log('--- End Multi-Select Test --- ');

            } else if (cleanedOptions.length >= 1) { // If not multi-select, click the first one for testing
                 console.log('--- Testing Single Select Click --- ');
                 const firstOptionText = cleanedOptions[0];
                 console.log(`  Attempting to click first option: "${firstOptionText}"`);
                 try {
                    const firstOptionLocator = dropdown.locator(`${optionSelector}:has-text("${firstOptionText}")`).first();
                    await firstOptionLocator.click({ timeout: 3000 });
                    console.log('    Successfully clicked first option.');
                } catch (clickError) {
                    console.error(`    Failed to click first option ("${firstOptionText}"):`, clickError);
                }
                 console.log('--- End Single Select Test --- ');
            } else {
                 console.log('No options extracted, cannot test clicking.');
            }
            
             // Optional: Close dropdown after test clicks
             try {
                  await page.locator('body').click({ position: { x: 0, y: 0 }, delay: 100, force: true }); 
                  await dropdown.waitFor({ state: 'hidden', timeout: 2000 });
                  console.log('Closed dropdown after test clicks.');
             } catch (closeError) { console.warn('Could not confirm dropdown closed after test clicks.'); }
            // --- End attempt ---

            // ... (HTML logging commented out) ...

        } catch (dropdownError) {
            console.error(`\x1b[31mError waiting for or processing dropdown (Selector: ${dropdownSelector}):\x1b[0m`, dropdownError);
            console.log('\x1b[33mAttempting to capture HTML anyway... [0m');
            try {
                 // fullHtml = await page.content(); // Removed HTML logging
                 console.log('--- Full Page HTML after click (dropdown wait failed) ---');
                 // console.log(fullHtml);
            } catch (htmlError) {
                 console.error('\x1b[31mFailed to get HTML after dropdown error.\x1b[0m');
            }
        }

        console.log('\nDebug script finished.')

    } catch (error) {
        console.error('\x1b[31mAn error occurred during debug script:\x1b[0m', error);
    } finally {
        console.log('Closing browser...');
        // await browser.close(); // Keep browser open
        console.log('Browser kept open for inspection. Manually close it when done.');
    }
}

debugSelect(); 