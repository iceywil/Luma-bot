import { Page, BrowserContext, Locator } from 'playwright';
import { readProfile } from '../api_flow/config'; // Import readProfile from config.ts
import { chooseBestFreeTicketLLM, callLLMBatched, LLMFieldRequest } from '../api_flow/llm'; // Adjust LLM imports
import { handleModal, pagesAwaitingManualSubmit, pagesWithPaidRegistration } from './modalHandler';
import { waitOutCloudflareChallenge, CloudflareChallengeError } from './cloudflare';
import { BrowserClosedError, isBrowserClosedError } from './browserClosed';
import { SUBMITTED_STATUSES } from './statusProbe';
import * as fs from 'fs/promises';

// Luma's approval_status for the signed-in account on the event open in `page`: null when Luma has no
// registration, undefined when it can't be read. Luma can take a moment to show a fresh application.
async function lumaRegistrationStatus(page: Page, attempts = 5): Promise<string | null | undefined> {
    const eventApiId = (await page.content().catch(() => '')).match(/"(?:event_)?api_id"\s*:\s*"(evt-[a-zA-Z0-9]+)"/)?.[1];
    if (!eventApiId) return undefined;
    let status: string | null | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0) await page.waitForTimeout(2000);
        status = await page.evaluate(async (id) => {
            const response = await fetch(`https://api.luma.com/event/get?event_api_id=${id}`, { credentials: 'include' });
            if (!response.ok) return undefined;
            const data = await response.json();
            const status = (data?.guest_data ?? data?.role ?? data?.guest_info)?.approval_status;
            return typeof status === 'string' ? status.toLowerCase() : null;
        }, eventApiId).catch(() => undefined);
        if (status && SUBMITTED_STATUSES.includes(status)) break;
    }
    return status;
}

// Clicks a button of the event page (main button, ticket). Something can sit on top of it for a moment
// (a card in a section still expanding): then bring it to the middle of the screen and retry, and as a last
// resort send the click to the button itself.
async function clickEventButton(page: Page, button: Locator): Promise<void> {
    try {
        await button.click({ timeout: 10000 });
    } catch (error: any) {
        if (!/intercepts pointer events|Timeout/i.test(error?.message || '')) throw error;
        console.warn('  Button covered or not clickable yet, retrying...');
        await button.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
        await page.waitForTimeout(1500);
        await button.click({ timeout: 5000 }).catch(() => button.dispatchEvent('click'));
    }
}

// Define selectors used in this module
const ticketSectionSelector = '.ticket-section';
const ticketPriceSelector = '.ticket-price, .price-tag';
const ticketRegisterButtonSelector = 'button:has-text("Register"), button:has-text("Get Ticket")';
// Redefined as an array of status texts
const pendingStatusTexts = [
    "Pending Approval", 
    "You’re In",
    "You're In",
    "You are registered",
    "On the waitlist",
    "You’re on the Waitlist",
    "You're on the waitlist",
    "You're Not Going",
    "YOU'RE ON THE WAITLIST",
]; 
const statusDivSelector = 'div.title.mt-2'; // Selector for the element containing the status text
const modalSelector = 'div.lux-overlay.glass'; // Define main modal selector locally

// --- Helper Function to Click "Register" or "Apply" and handle LLM --- 
async function clickRegisterOrApplyAndProcess(page: Page, context: BrowserContext, config: Record<string, string>, profileData: Record<string, string>): Promise<boolean> {
    let registrationSuccessful = false; // Declare and initialize
    console.log('Interaction complete. Returning registration success status.');
    return registrationSuccessful; // Ensure this reflects the outcome
}

// --- Main Event Processing Function --- 
export async function processEventPage(
    page: Page, 
    context: BrowserContext, 
    eventUrl: string, 
    config: Record<string, string>,
    profile?: Record<string, string>
): Promise<boolean> {
    let overallSuccess = false;
    // Set once the bot clicked something that should register: the result is then checked with Luma
    let attempted = false;
    const profileData = profile ?? await readProfile(); // Load profile data once
    if (Object.keys(profileData).length === 0) {
        console.warn('Profile data is empty. LLM calls may be impaired.');
    }

    // Keep track of the new page opened for this event
    let eventPage: Page | null = null; 

    try {
        console.log(`  Navigating to event page: ${eventUrl}`);
        eventPage = await context.newPage();
        await eventPage.goto(eventUrl, { waitUntil: 'load', timeout: 60000 }); // Changed to waitUntil: 'load'        
        await waitOutCloudflareChallenge(eventPage, config);
       
        // --- DEBUG: Save HTML content to a file ---
        try {
            const htmlContent = await eventPage.content();
            await fs.writeFile('test.txt', htmlContent, 'utf8');
            console.log('  Successfully saved page HTML to test.txt for debugging.');
        } catch (htmlError) {
            console.error('  Failed to save page HTML to test.txt:', htmlError);
        }
        // --- END DEBUG ---

        let processedSuccessfully = false;
        let eventStatus = 'Skipped'; // Default status
        let chosenTicket = 'N/A'; // Declare chosenTicket here
        let modalData: Record<string, string | string[] | null> | null = null; // To store modal results

        console.log(`Page loaded. Checking current registration status...`);

        // --- Initial Status Check (Simplified) --- 
        let alreadyRegisteredOrPending = false;
        try {
            console.log(`  Checking initial status using statusDivSelector: ${statusDivSelector}`);
            const statusDiv = eventPage.locator(statusDivSelector).first();
            await statusDiv.waitFor({ state: 'visible', timeout: 3000 }); // Wait for the specific div
            const statusText = (await statusDiv.textContent() || '').trim();
            console.log(`    Found statusDiv. Text: "${statusText}"`);
            
            // Check if the found text contains any of the predefined pending/registered/waitlist statuses (CASE-SENSITIVE)
            const matchFound = pendingStatusTexts.some(pendingText => 
                statusText.includes(pendingText) // Direct, case-sensitive check
            );
            
            console.log(`      DEBUG: statusText="${statusText}", matchFound=${matchFound}`);

            if (matchFound) {
                console.log('    Status: Match found in statusDiv text. Setting alreadyRegisteredOrPending = true.');
                alreadyRegisteredOrPending = true;
            } else {
                console.log('    Status: Text in statusDiv did not match expected keywords.');
            }
        } catch (e) {
             console.log('    Status: Did not find status via statusDiv selector or timed out.');
             // If the specific status div isn't found, assume not registered/pending
        }
        
        // Return true if status indicates skipping
        if (alreadyRegisteredOrPending) {
            console.log('  Status: Already registered, pending approval, waitlisted, or event full. Skipping...');
            eventStatus = 'Pending/Registered/Waitlisted/Full'; // Consolidated status
            processedSuccessfully = true; 
            return true; // Exit early
        } else {
            console.log('  Status: No initial registered/pending/waitlist status found. Proceeding...');
        }
        
        // --- End Initial Status Check ---

        // --- 1. Check for Tickets First (Restored) ---
        const ticketSections = eventPage.locator(ticketSectionSelector);
        const ticketCount = await ticketSections.count();
        let foundTickets = false;
        const freeTicketOptions: { name: string, sectionLocator: import('playwright').Locator, buttonLocator: import('playwright').Locator }[] = [];

        if (!processedSuccessfully && ticketCount > 0) { // Only check if not already processed
            console.log(`Found ${ticketCount} potential ticket sections.`);
            foundTickets = true;
            for (let i = 0; i < ticketCount; i++) {
                const section = ticketSections.nth(i);
                const ticketNameElement = section.locator('.ticket-name, h3, h4').first();
                const ticketName = (await ticketNameElement.textContent() || `Ticket ${i + 1}`).trim();
                const priceElement = section.locator(ticketPriceSelector).first();
                let isFree = false;
                if (await priceElement.isVisible({ timeout: 1000 })) {
                    const priceText = (await priceElement.textContent() || '').trim().toLowerCase();
                    console.log(`  Ticket "${ticketName}" price text: "${priceText}"`);
                    if (priceText === 'free' || priceText === 'gratuit' || priceText === '$0' || priceText === '€0' || priceText === '0$' || priceText === '0€') {
                        isFree = true;
                    }
                } else {
                    console.log(`  Ticket "${ticketName}" has no visible price element, assuming potentially free.`);
                    isFree = true;
                }

                if (isFree) {
                    const registerButton = section.locator(ticketRegisterButtonSelector).first();
                    if (await registerButton.isVisible({ timeout: 1000 })) {
                        console.log(`  Found free ticket option: "${ticketName}"`);
                        freeTicketOptions.push({ name: ticketName, sectionLocator: section, buttonLocator: registerButton });
                    } else {
                        console.log(`  Free ticket "${ticketName}" found, but no visible register button.`);
                    }
                }
            }

            if (freeTicketOptions.length > 0) {
                let chosenTicketName: string | null = null;
                if (freeTicketOptions.length === 1) {
                    chosenTicketName = freeTicketOptions[0].name;
                    console.log(`Only one free ticket option ("${chosenTicketName}"), selecting it.`);
                } else {
                    chosenTicketName = await chooseBestFreeTicketLLM(freeTicketOptions.map(opt => opt.name), profileData, config);
                }

                if (chosenTicketName) {
                    const chosenOption = freeTicketOptions.find(opt => opt.name === chosenTicketName);
                    if (chosenOption) {
                        console.log(`Attempting to register for chosen free ticket: "${chosenTicketName}"`);
                        try {
                            await chosenOption.buttonLocator.click();
                            attempted = true;
                            console.log(`  Clicked register button for ticket "${chosenTicketName}".`);
                            // Check if modal appeared after ticket click
                            try {
                                await eventPage.waitForSelector(modalSelector, { state: 'visible', timeout: 7000 });
                                console.log('Modal appeared after clicking free ticket. Handling modal...');
                                modalData = await handleModal(eventPage, config, profileData);
                                eventStatus = modalData ? 'Ticket Registered (Free + Modal)' : 'Modal Processing Failed';
                                processedSuccessfully = !!modalData; // Success depends on modal handling
                            } catch (modalError) {
                                console.log('No modal appeared after clicking free ticket (or timed out). Assuming direct registration/confirmation.');
                                eventStatus = 'Ticket Registered (Free - Direct)';
                                processedSuccessfully = true; // Assume success if no modal after click
                            }
                            chosenTicket = chosenTicketName;
                        } catch (ticketClickError) {
                            console.error(`\x1b[31mError clicking register button for ticket "${chosenTicketName}":\x1b[0m`, ticketClickError);
                            eventStatus = 'Error Clicking Free Ticket';
                            processedSuccessfully = false;
                        }
                    } else {
                        console.log('Error: LLM chose a ticket name not found in the options?');
                        eventStatus = 'LLM Ticket Choice Error';
                        processedSuccessfully = false;
                    }
                } else {
                    console.log('Could not determine which free ticket to choose. Skipping ticket registration for now.');
                    eventStatus = 'Skipped (Ticket Choice Failed)';
                    // Do not set processedSuccessfully = true here, allow checking primary button
                }
            } else {
                 console.log('No free tickets with registration buttons found.');
                 // Allow proceeding to primary button check
            }
        } // End if ticketCount > 0

        // If tickets were found but did not result in a successful processing action, log it.
        // This does NOT prevent checking the primary button.
        if (foundTickets && !processedSuccessfully) {
            console.log('Ticket sections found, but no free ticket action was successfully completed.');
            if (eventStatus === 'Skipped') { // Update status only if not already set to an error
                 eventStatus = 'Skipped (Paid/No Actionable Free Tickets)';
            }
        }
        // --- End Restored Ticket Check ---

        // --- Current Luma ticket picker (button.ticket-type-btn): a ticket must be picked before Register enables ---
        if (!processedSuccessfully) {
            const ticketButtons = eventPage.locator('button.ticket-type-btn');
            if (await ticketButtons.count() > 0) {
                const tickets = await ticketButtons.evaluateAll((buttons) => buttons.map((b) => ({
                    name: b.querySelector('.name')?.textContent?.trim() || '',
                    // Sold out (or otherwise unavailable) tickets are disabled buttons
                    available: !(b as HTMLButtonElement).disabled,
                    // The price has no fixed element: read "Free", "$99.00", "S$25", "€10", "25 EUR"... from the button text
                    price: ((b as HTMLElement).innerText || '').match(/\b(?:free|gratuit)\b|(?:[$€£¥]|\b[A-Z]{1,3}\$)\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:[$€£¥]|USD|EUR|GBP|SGD|CHF)\b/i)?.[0] || '',
                })));
                console.log(`Found ticket picker: ${tickets.map((t) => `"${t.name}" (${t.price || 'no price found'}${t.available ? '' : ', unavailable'})`).join(', ')}`);
                // "Free", or an amount with no non-zero digit ("$0"). No price found counts as paid: picking a paid
                // ticket leads to a checkout.
                const freeTickets = tickets.map((t, index) => ({ ...t, index }))
                    .filter((t) => t.available && (/free|gratuit/i.test(t.price) || (/\d/.test(t.price) && !/[1-9]/.test(t.price))));
                if (freeTickets.length === 0) {
                    console.log('  No free ticket available (paid or sold out). Skipping event.');
                    eventStatus = 'Skipped (No free ticket available)';
                    processedSuccessfully = true;
                } else {
                    const chosenName = freeTickets.length === 1
                        ? freeTickets[0].name
                        : await chooseBestFreeTicketLLM(freeTickets.map((t) => t.name), profileData, config);
                    const chosen = freeTickets.find((t) => t.name === chosenName) ?? freeTickets[0];
                    const ticketButton = ticketButtons.nth(chosen.index);
                    // Multi-ticket pickers have a +/- count selector; the enabled count button is "+"
                    const plusButton = ticketButton.locator('.count-button[aria-disabled="false"]').last();
                    if (await plusButton.count() > 0) {
                        await clickEventButton(eventPage, plusButton);
                    } else if (!/\bselected\b/.test(await ticketButton.getAttribute('class') || '')) {
                        await clickEventButton(eventPage, ticketButton);
                    }
                    await eventPage.waitForTimeout(500);
                    console.log(`  Selected free ticket "${chosen.name}".`);
                    chosenTicket = chosen.name;
                }
            }
        }

        // --- 4. If still not processed, check Primary Button --- 
        // Renumbered from 4, but logic remains.
        if (!processedSuccessfully) {
            const primaryButtonSelector = 'div.event-page-right button.primary:visible'; 
            const primaryButton = eventPage.locator(primaryButtonSelector).first();

            // Check if the primary button is visible
            if (await primaryButton.isVisible({ timeout: 3000 })) {
                const buttonText = await primaryButton.textContent() || '';
                console.log(`Found primary button with text: "${buttonText}"`);

                // Use only English button texts
                if (await primaryButton.isDisabled()) {
                    console.log(`Primary button "${buttonText}" is disabled (sold out, closed or needs a paid ticket). Skipping.`);
                    eventStatus = `Skipped (Disabled Button: "${buttonText}")`;
                    processedSuccessfully = true;
                } else if (/1-click|one[- ]click/i.test(buttonText)) {
                    console.log('Attempting 1-click registration...');
                    await clickEventButton(eventPage, primaryButton);
                    attempted = true;
                    // Some one-click buttons still open a short confirmation form
                    const modalAppeared = await eventPage.waitForSelector(modalSelector, { state: 'visible', timeout: 5000 }).then(() => true, () => false);
                    if (modalAppeared) {
                        modalData = await handleModal(eventPage, config, profileData);
                        processedSuccessfully = !!modalData;
                    } else {
                        await eventPage.waitForTimeout(2500);
                        processedSuccessfully = true;
                    }
                    eventStatus = processedSuccessfully ? 'Registered (1-Click)' : 'Modal Processing Failed (1-Click)';
                } else if (/Register|Apply|Ask to Join|Request to Join|Accept Invite|Get Ticket/.test(buttonText)) {
                    console.log('Attempting registration/application...');
                    await clickEventButton(eventPage, primaryButton);
                    attempted = true;
                    // Usually opens the registration form; some events register right away
                    const modalAppeared = await eventPage.waitForSelector(modalSelector, { state: 'visible', timeout: 5000 }).then(() => true, () => false);
                    if (modalAppeared) {
                        modalData = await handleModal(eventPage, config, profileData);
                        processedSuccessfully = !!modalData;
                    } else {
                        await waitOutCloudflareChallenge(eventPage, config);
                        await eventPage.waitForTimeout(2500);
                        processedSuccessfully = true;
                    }
                    eventStatus = processedSuccessfully ? 'Registered/Applied' : 'Modal Processing Failed';
                } else if (buttonText.includes('Join Waitlist')) {
                    console.log('Attempting to join the waitlist...');
                    await clickEventButton(eventPage, primaryButton);
                    attempted = true;
                    // Most waitlists open the same registration form as Register (questions, then Turnstile on submit)
                    const modalAppeared = await eventPage.waitForSelector(modalSelector, { state: 'visible', timeout: 5000 }).then(() => true, () => false);
                    if (modalAppeared) {
                        modalData = await handleModal(eventPage, config, profileData);
                        processedSuccessfully = !!modalData;
                    } else {
                        await waitOutCloudflareChallenge(eventPage, config);
                        await eventPage.waitForTimeout(2500);
                        processedSuccessfully = true;
                    }
                    eventStatus = processedSuccessfully ? 'Joined Waitlist' : 'Modal Processing Failed (Waitlist)';
                } else if (buttonText.includes('1-click') || buttonText.includes('RSVP in one click')) {
                     console.log('Attempting 1-click registration...');
                     try {
                         await clickEventButton(eventPage, primaryButton);
                         attempted = true;
                         // Add a short pause after clicking
                         await page.waitForTimeout(2500); // Wait 2.5 seconds for action to complete
                         console.log('1-click registration completed (assumed success after click).');
                         processedSuccessfully = true; 
                         eventStatus = 'Registered (1-Click)';
                     } catch(e) {
                          console.error('\x1b[31mError during 1-click registration click:\x1b[0m', e);
                          eventStatus = 'Error (1-Click)';
                          processedSuccessfully = false;
                     }
                } else {
                    console.log(`Unknown primary button text: "${buttonText}". Cannot process.`);
                    eventStatus = `Skipped (Unknown Button: "${buttonText}")`;
                    processedSuccessfully = false;
                }
            } else if (await eventPage.getByText(/^Registration Closed$/).first().isVisible().catch(() => false)) {
                console.log('Registration is closed for this event. Skipping.');
                processedSuccessfully = true;
                eventStatus = 'Skipped (Registration Closed)';
            } else {
                 // Primary button NOT visible
                 console.log('No visible primary action button found (Register/Join Waitlist/etc.). Assuming already registered or waitlisted.');
                 processedSuccessfully = true;
                 eventStatus = 'Registered/Waitlisted (No Button Found)';
            }
        }

        // --- Final Check (If Nothing Above Processed) --- 
        if (!processedSuccessfully && eventStatus === 'Skipped') {
            console.log('No actionable button, free ticket, or known status found.');
            eventStatus = 'Skipped (No Action Found)';
            processedSuccessfully = true;
        }

        // A failed step may be a Cloudflare challenge that appeared after clicking (e.g. on submit)
        if (!processedSuccessfully) await waitOutCloudflareChallenge(eventPage, config);

        // The form was a checkout (paid ticket): nothing was submitted, it's a skip
        if (pagesWithPaidRegistration.has(eventPage)) {
            processedSuccessfully = true;
            attempted = false;
            eventStatus = 'Skipped (Paid registration)';
        }

        // What's on screen can mislead (a form that stays open after a successful submit, or a click that
        // did nothing): Luma's own status decides. A form left for a manual submit isn't submitted yet.
        if (attempted && !pagesAwaitingManualSubmit.has(eventPage)) {
            const status = await lumaRegistrationStatus(eventPage);
            if (status && SUBMITTED_STATUSES.includes(status)) {
                if (!processedSuccessfully) console.log(`  Luma has the registration anyway (${status}).`);
                processedSuccessfully = true;
                eventStatus = `Registered (${status})`;
            } else if (status === null || status) {
                console.log(`\x1b[31m  Luma has no registration for this event${status ? ` (status: ${status})` : ''}.\x1b[0m`);
                processedSuccessfully = false;
                eventStatus = `${eventStatus} (not registered on Luma)`;
            } else {
                console.log('  Could not read the registration status from Luma, keeping the result as is.');
            }
        }
        overallSuccess = processedSuccessfully;
        console.log(`  Registration attempt for ${eventUrl} completed. Success: ${overallSuccess}`);
    } catch (error) {
        if (error instanceof CloudflareChallengeError) throw error;
        if (isBrowserClosedError(error)) throw new BrowserClosedError();
        console.error(`\x1b[31m  Error processing event ${eventUrl}:\x1b[0m`, error);
        overallSuccess = false;
    } finally {
        console.log(`--- Finished processing ${eventUrl} ---`);
        // A filled form waiting for a manual submit stays open; the runner hands it to the user
        if (eventPage && !eventPage.isClosed() && !pagesAwaitingManualSubmit.has(eventPage)) {
            await eventPage.close();
        }
    } 
    return overallSuccess;
}
