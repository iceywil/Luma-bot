import { Page, Locator } from 'playwright';

// Last mouse position per page: Playwright doesn't expose it
const mousePositions = new WeakMap<Page, { x: number; y: number }>();
const randomIn = (min: number, max: number) => min + Math.random() * (max - min);

/**
 * Clicks like a person: the cursor travels on a slight curve, easing in and out, to a random point inside
 * the element, rests a moment, then presses and releases. locator.click() jumps straight to the center
 * with no mousemove before it, which bot checks (Turnstile) can see.
 */
export async function humanClick(page: Page, locator: Locator): Promise<void> {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (!box) throw new Error('Element to click has no bounding box (hidden?)');
    await humanClickAt(page, { x: box.x + box.width * randomIn(0.3, 0.7), y: box.y + box.height * randomIn(0.3, 0.7) });
}

// humanClick at a point of the page (CSS pixels from the top-left of the viewport)
export async function humanClickAt(page: Page, target: { x: number; y: number }): Promise<void> {
    // First move on this page: start somewhere above-left of the target, where the cursor plausibly was
    const start = mousePositions.get(page) ?? { x: Math.max(5, target.x - randomIn(150, 400)), y: Math.max(5, target.y - randomIn(80, 300)) };
    // Quadratic curve whose control point sits off the straight line
    const control = {
        x: (start.x + target.x) / 2 + randomIn(-1, 1) * Math.abs(target.y - start.y) * 0.4,
        y: (start.y + target.y) / 2 + randomIn(-1, 1) * Math.abs(target.x - start.x) * 0.4,
    };
    const steps = Math.round(randomIn(18, 32));
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const x = (1 - eased) ** 2 * start.x + 2 * (1 - eased) * eased * control.x + eased ** 2 * target.x;
        const y = (1 - eased) ** 2 * start.y + 2 * (1 - eased) * eased * control.y + eased ** 2 * target.y;
        await page.mouse.move(x, y);
        await page.waitForTimeout(randomIn(6, 18));
    }
    mousePositions.set(page, target);
    await page.waitForTimeout(randomIn(120, 350));
    await page.mouse.down();
    await page.waitForTimeout(randomIn(60, 140));
    await page.mouse.up();
}

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
    // An empty text is "contained" in every label: it would return the form's first field
    if (!labelText.trim()) return null;

    try {
        // Find the label that contains the text. This is our primary starting point.
        const labelSelector = `label:has-text("${labelText.replace(/"/g, '\\"')}")`;
        const labels = modalLocator.locator(labelSelector);
        let label = labels.first();
        // "contains" also matches longer labels ("Your job title" is in "What is your job title"):
        // when several match, take the one that is exactly this label (ignoring case, punctuation and the "*")
        if (await labels.count() > 1) {
            const normalize = (text: string) => text.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
            const exact = (await labels.allTextContents()).findIndex((text) => normalize(text) === normalize(labelText));
            if (exact >= 0) label = labels.nth(exact);
        }

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