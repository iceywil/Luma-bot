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

    try {
        // Find the label that contains the text. This is our primary starting point.
        const labelSelector = `label:has-text("${labelText.replace(/"/g, '\\"')}")`;
        const label = modalLocator.locator(labelSelector).first();

        if (await label.isVisible({ timeout: 500 })) {
            // Strategy 1: The 'for' attribute is the most reliable method.
            const forId = await label.getAttribute('for');
            if (forId) {
                const field = modalLocator.locator(`#${forId}`);
                if (await field.count() > 0 && await field.isVisible({ timeout: 200 })) {
                    console.log(`[findFieldByLabel] Found field #${forId} via label's 'for' attribute.`);
                    return field;
                }
            }

            // Strategy 2: The field is nested inside the label tag.
            const nestedField = label.locator('input, select, textarea').first();
            if (await nestedField.count() > 0 && await nestedField.isVisible({ timeout: 100 })) {
                console.log('[findFieldByLabel] Found field nested inside the label.');
                return nestedField;
            }

            // Strategy 3: The field is within the same parent container as the label.
            const parentContainer = label.locator('xpath=./ancestor::*[1]');
            const fieldInParent = parentContainer.locator('input, select, textarea').first();
             if (await fieldInParent.count() > 0 && await fieldInParent.isVisible({ timeout: 100 })) {
                console.log('[findFieldByLabel] Found field within the same parent container as the label.');
                return fieldInParent;
            }

            // Strategy 4: The field is a sibling of the label's parent.
            const parentSiblingField = label.locator('xpath=./parent::*/following-sibling::*').locator('input, select, textarea').first();
            if (await parentSiblingField.count() > 0 && await parentSiblingField.isVisible({ timeout: 100 })) {
                console.log('[findFieldByLabel] Found field as a sibling to the label\'s parent container.');
                return parentSiblingField;
            }
        }
        
        // Strategy 5: Find by placeholder text as a fallback.
        const placeholderSelector = `[placeholder*="${labelText.replace(/"/g, '\\"')}"]`;
        const fieldByPlaceholder = modalLocator.locator(placeholderSelector).first();
        if (await fieldByPlaceholder.count() > 0 && await fieldByPlaceholder.isVisible({ timeout: 200 })) {
            console.log(`[findFieldByLabel] Found field by placeholder text: "${labelText}"`);
            return fieldByPlaceholder;
        }

        console.log(`[findFieldByLabel] Could not find a reliable field for label: "${labelText}"`);
        return null;

    } catch (error) {
        console.error(`[findFieldByLabel] Error searching for field with label "${labelText}":`, error);
        return null;
    }
} 