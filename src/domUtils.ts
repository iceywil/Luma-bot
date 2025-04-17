import { Page, Locator } from 'playwright';

/**
 * Clicks an element if it is visible and enabled.
 * @param locator The Playwright Locator for the element.
 * @param description A description of the element for logging.
 * @param timeout Timeout for waiting for the element.
 * @returns True if clicked, false otherwise.
 */
export async function clickIfPossible(locator: Locator, description: string, timeout = 5000): Promise<boolean> {
    console.log(`Attempting to click "${description}"...`);
    try {
        await locator.waitFor({ state: 'visible', timeout });
        console.log(`  "${description}" is visible.`);
        if (await locator.isEnabled({ timeout: 500 })) { // Quick check if enabled
            console.log(`  "${description}" is enabled. Clicking.`);
            await locator.click({ timeout }); // Use the main timeout for the click itself
            console.log(`  Successfully clicked "${description}".`);
            return true;
        } else {
            console.log(`  Skipping click: "${description}" is not enabled.`);
            return false;
        }
    } catch (error: any) {
        // Log specific errors for timeout vs other issues
        if (error.name === 'TimeoutError') {
            console.log(`  Skipping click: "${description}" did not become visible/enabled within ${timeout}ms.`);
        } else {
            console.error(`  Error clicking "${description}":`, error);
        }
        return false;
    }
}

/**
 * Finds a form field (input, select, textarea) associated with a label containing the given text.
 * Handles various label association methods.
 * @param modalLocator The Playwright Locator for the modal or form container.
 * @param labelText The text content of the label to search for.
 * @param fieldTypeHint Optional hint ('text', 'select', 'multiselect') to help refine the search.
 * @returns A Locator for the associated form field, or null if not found.
 */
export async function findFieldByLabel(modalLocator: Locator, labelText: string, fieldTypeHint?: 'text' | 'select' | 'multiselect'): Promise<Locator | null> {
    console.log(`[findFieldByLabel] Searching for field associated with label containing text: "${labelText}"`);

    // Sanitize labelText for use in selectors if needed (e.g., escaping quotes)
    const sanitizedLabelText = labelText.replace(/"/g, '"'); // Basic example

    try {
        // 1. Try finding label directly containing the text, then check `for` attribute
        const directLabel = modalLocator.locator(`label:has-text("${sanitizedLabelText}")`).first();
        if (await directLabel.isVisible({ timeout: 200 })) {
            const forAttr = await directLabel.getAttribute('for');
            if (forAttr) {
                const targetField = modalLocator.locator(`#${forAttr}`);
                if (await targetField.isVisible({ timeout: 200 })) {
                    console.log(`[findFieldByLabel] Found via direct label [for="${forAttr}"]`);
                    return targetField;
                }
            }
             // 1b. If label has no `for`, check immediate following input/select/textarea
             const nextField = directLabel.locator('xpath=./following-sibling::*[self::input or self::select or self::textarea][1]');
             if (await nextField.isVisible({ timeout: 200 })) {
                 console.log('[findFieldByLabel] Found via direct label + following-sibling field');
                 return nextField;
             }
             // 1c. If label wraps the input (common)
             const wrappedField = directLabel.locator('input, select, textarea').first();
             if (await wrappedField.isVisible({ timeout: 200 })) {
                 console.log('[findFieldByLabel] Found via wrapped field inside label');
                 return wrappedField;
             }
        }

        // 2. Try finding by aria-labelledby if label has an ID
        const labelWithId = modalLocator.locator(`label:has-text("${sanitizedLabelText}")[id]`).first();
        if (await labelWithId.isVisible({ timeout: 200 })) {
             const labelId = await labelWithId.getAttribute('id');
             if (labelId) {
                 const targetField = modalLocator.locator(`[aria-labelledby="${labelId}"]`);
                 if (await targetField.isVisible({ timeout: 200 })) {
                     console.log(`[findFieldByLabel] Found via aria-labelledby="${labelId}"`);
                     return targetField;
                 }
             }
        }

        // 3. Special Case: Multiselect triggers (using hint)
        // These often have complex structures, rely on the hint if provided
        if (fieldTypeHint === 'multiselect') {
            // Find the div/element containing the label text, then find the specific trigger within/near it
            // This selector might need adjustment based on actual Luma structure
            const multiSelectTrigger = modalLocator.locator(`div:has(label:has-text("${sanitizedLabelText}"))`).locator('div.lux-menu-trigger-wrapper div.luma-input span').first();
            // Alternative: Find label, go up to a common parent, then down to trigger
            // const multiSelectTrigger = modalLocator.locator(`label:has-text("${sanitizedLabelText}")`).locator('xpath=ancestor::div[contains(@class, "form-group")]//div[contains(@class, "lux-menu-trigger")]'); // Example
            if (await multiSelectTrigger.isVisible({ timeout: 200 })) {
                 console.log('[findFieldByLabel] Found multiselect trigger near label using hint.');
                 return multiSelectTrigger;
            }
        }
        
        // 4. Fallback: Look for input/select/textarea *near* the label text (less reliable)
        // Find an element containing the label text, then look for inputs nearby
        const elementContainingLabel = modalLocator.locator(`*:has-text("${sanitizedLabelText}")`).first();
        if (await elementContainingLabel.isVisible({timeout: 200})) {
             const nearbyField = elementContainingLabel.locator('xpath=following::input[1] | following::select[1] | following::textarea[1] | ancestor::*[./label][1]//input | ancestor::*[./label][1]//select | ancestor::*[./label][1]//textarea').first();
             if (await nearbyField.isVisible({timeout: 200})) {
                console.log('[findFieldByLabel] Found via nearby field (fallback).');
                return nearbyField;
             }
        }

        console.warn(`[findFieldByLabel] Could not reliably find field associated with label: "${labelText}"`);
        return null;

    } catch (error) {
        console.error(`[findFieldByLabel] Error searching for field with label "${labelText}":`, error);
        return null;
    }
} 