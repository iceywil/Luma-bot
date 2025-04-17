import { Page, BrowserContext } from 'playwright';
import { readProfile } from './config'; // Import readProfile from config.ts
import { chooseBestFreeTicketLLM, callLLMBatched, LLMFieldRequest } from './llm'; // Adjust LLM imports
import { handleModal } from './modalHandler';
import { findFieldByLabel } from './domUtils'; // Add missing import
import * as fs from 'fs/promises'; // Import fs

// Define selectors used in this module
const ticketSectionSelector = '.ticket-section';
const ticketPriceSelector = '.ticket-price, .price-tag';
const ticketRegisterButtonSelector = 'button:has-text("Register"), button:has-text("Get Ticket")';
const primaryButtonSelector = 'button.btn.luma-button.primary.solid.full-width';
const askToJoinText = ["Demander à rejoindre", "Ask to Join"];
const waitlistText = ["Rejoindre la liste d'attente", "Join Waitlist"];
const oneClickText = ["Inscription en un clic"];
// Redefined as an array of status texts
const pendingStatusTexts = [
    "Pending Approval", 
    "You're In", 
    "You're In",
    "You are registered",
    "On the waitlist"
]; 
const statusDivSelector = 'div.title.mt-2.fw-medium'; // Selector for the element containing the status text
const registrationLogFile = 'registrations.txt'; // Define log file name
const modalSelector = 'div.lux-overlay.glass'; // Define main modal selector locally
const checkboxContainerSelector = '.lux-checkbox'; // Define checkbox container selector
const checkboxInputSelector = 'input[type="checkbox"]'; 
const checkboxLabelSelector = 'label.text-label > div'; 
const checkboxClickTargetSelector = 'label.checkbox-icon';

// Define custom select selectors (previously missing)
const customSelectDropdownSelector = 'div.lux-menu'; 
const customSelectOptionSelector = 'div.lux-menu-item'; 

// Add selectors for the Terms Modal
const termsModalSelector = 'div.lux-modal:has-text("Accept Terms")';
const termsModalTextareaSelector = 'textarea.lux-naked-input';
const termsModalSubmitButtonSelector = 'button:has-text("Sign & Accept")';

// Function to append log entry
async function logRegistration(entry: string): Promise<void> {
    try {
        await fs.appendFile(registrationLogFile, entry + '\n', 'utf8');
    } catch (err) {
        console.error(`\x1b[31mError writing to ${registrationLogFile}:\x1b[0m`, err);
    }
}

export async function processEventPage(
    page: Page, 
    context: BrowserContext, 
    link: string, 
    config: Record<string, string>
): Promise<boolean> {
    console.log(`\n--- Processing event: ${link} ---`);
    const eventPage = await context.newPage();
    let processedSuccessfully = false;
    let eventStatus = 'Skipped'; // Default status
    let chosenTicket = 'N/A'; // Default ticket
    let modalData: Record<string, string | string[] | null> | null = null; // To store modal results
    const fieldsToAskLLM: LLMFieldRequest[] = []; // Declare earlier

    try {
        console.log(`Navigating to ${link}`);
        await eventPage.goto(link, { waitUntil: 'networkidle', timeout: 20000 });
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
                    const optionNames = freeTicketOptions.map(opt => opt.name);
                    const currentProfile = await readProfile(); // Need profile for ticket choice
                    chosenTicketName = await chooseBestFreeTicketLLM(optionNames, currentProfile, config);
                }

                if (chosenTicketName) {
                    const chosenOption = freeTicketOptions.find(opt => opt.name === chosenTicketName);
                    if (chosenOption) {
                        console.log(`Attempting to register for chosen free ticket: "${chosenTicketName}"`);
                        try {
                            await chosenOption.buttonLocator.click();
                            console.log(`  Clicked register button for ticket "${chosenTicketName}".`);
                            // Check if modal appeared after ticket click
                            try {
                                await eventPage.waitForSelector(modalSelector, { state: 'visible', timeout: 7000 });
                                console.log('Modal appeared after clicking free ticket. Handling modal...');
                                modalData = await handleModal(eventPage, config);
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
                if (buttonText.includes('Register') || buttonText.includes('Apply') || buttonText.includes("Ask to Join") || buttonText.includes("Request to Join")) {
                    console.log('Attempting registration/application...');
                    await primaryButton.click({ timeout: 10000 });
                    modalData = await handleModal(eventPage, config);
                    eventStatus = modalData ? 'Registered/Applied (Modal Submitted)' : 'Modal Processing Failed';
                    processedSuccessfully = !!modalData;
                } else if (buttonText.includes('Join Waitlist')) {
                    // Revert to checking interactability via trial click ONLY
                    console.log('Checking interactability of "Join Waitlist" button...');
                    try {
                        // Trial run: Check if clickable
                        await primaryButton.click({ trial: true });
                        
                        // If trial succeeds, proceed with actual click
                        console.log('  Button is interactable. Attempting to join waitlist...');
                        await primaryButton.click({ timeout: 10000 }); // Actual click
                        await eventPage.waitForTimeout(1500); 
                        console.log('  Clicked "Join Waitlist" button and waited briefly.');
                        processedSuccessfully = true;
                        eventStatus = 'Joined Waitlist (Clicked Button)';

                    } catch (e) {
                        // If trial fails, assume already waitlisted
                        console.log('  "Join Waitlist" button not immediately interactable (likely obscured/already waitlisted).');
                        processedSuccessfully = true;
                        eventStatus = 'On Waitlist (Button Not Interactable)';
                    }
                } else if (buttonText.includes('1-click')) {
                     console.log('Attempting 1-click registration...');
                     try {
                         await primaryButton.click({ timeout: 10000 });
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
                    processedSuccessfully = true;
                }
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

    } catch (error) {
        console.error('\x1b[31mError processing event page:\x1b[0m', error);
        eventStatus = `Error (${error instanceof Error ? error.message : String(error)})`;
        processedSuccessfully = false;
    } finally {
        console.log(`--- Finished processing ${link} ---`);
        // Log the result to the file
        const logEntry = JSON.stringify({ 
            timestamp: new Date().toISOString(),
            eventLink: link,
            status: eventStatus,
            chosenTicket: chosenTicket,
            modalData: modalData 
        });
        await logRegistration(logEntry);

        if (eventPage && !eventPage.isClosed()) {
            await eventPage.close();
        }
    }
    
    return processedSuccessfully;
}
