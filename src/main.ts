import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { Browser, Page } from 'playwright';
import * as readline from 'readline/promises';
import { readConfig, readProfile } from './config'; // Restore readConfig import
import { processEventPage } from './eventProcessor'; // Import event processing function
import * as fs from 'fs/promises'; // Import fs for file operations
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env file
dotenv.config();

// Define file for events that failed registration
const toRegisterFile = 'to_register.txt';

// Close readline interface setup, as it's handled in modalHandler now
// const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// --- Helper Function for Appending Failed Event ---
async function appendToRegisterFile(eventUrl: string): Promise<void> {
    try {
        await fs.appendFile(toRegisterFile, eventUrl + '\n', 'utf8');
        console.log(`  -> Appended failed event URL to ${toRegisterFile}`);
    } catch (err) {
        console.error(`\x1b[31mError writing failed event to ${toRegisterFile}:\x1b[0m`, err);
    }
}

// --- Helper Function for Scrolling ---
async function autoScroll(page: Page): Promise<void> {
  console.log('  Starting auto-scroll...');
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let lastHeight = document.body.scrollHeight;
      const scrollDelay = 2000; // Wait 2 seconds after each scroll attempt
      let consecutiveStableScrolls = 0;
      const requiredStableScrolls = 3; // Require height stable for 3 checks
      let totalScrolls = 0;
      const maxScrolls = 50; // Safety break

      console.log(`  Initial scroll height: ${lastHeight}px`);

      const scrollInterval = setInterval(() => {
        totalScrolls++;
        console.log(`  Scrolling attempt #${totalScrolls}...`);
        window.scrollTo(0, document.body.scrollHeight);
        const newHeight = document.body.scrollHeight;

        if (newHeight === lastHeight) {
          consecutiveStableScrolls++;
          console.log(`  Scroll height stable (${newHeight}px), check ${consecutiveStableScrolls}/${requiredStableScrolls}`);
        } else {
          lastHeight = newHeight;
          consecutiveStableScrolls = 0; // Reset if height changes
          console.log(`  Scroll height changed to ${newHeight}px`);
        }

        if (consecutiveStableScrolls >= requiredStableScrolls || totalScrolls >= maxScrolls) {
          clearInterval(scrollInterval);
          if (totalScrolls >= maxScrolls) {
               console.warn('  Auto-scroll hit max attempts. Stopping.');
          } else {
               console.log('  Scroll height stable. Auto-scrolling finished.');
          }
          resolve();
        }
      }, scrollDelay);
    });
  });
}
// --- End Helper Function ---

// --- Main Function --- 
async function main() {
  // Apply stealth plugin
  const stealthPlugin = stealth();
  chromium.use(stealthPlugin);

  // --- Define Paths for Persistent Context ---
  // !!! IMPORTANT: Verify this path points to your specific Chrome profile folder (e.g., Default, Profile 1) !!!
  const userDataDir = '/Users/a/Library/Application Support/Google/Chrome/'; 
  const executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

  console.log(`Launching Chrome (${executablePath}) with profile (${userDataDir}) using stealth...`);
  
  // Launch Persistent Context using playwright-extra chromium
  const context = await chromium.launchPersistentContext(userDataDir, { 
    headless: false,
    executablePath: executablePath,
    args: [
        '--disable-blink-features=AutomationControlled' // Keep stealth-related args if needed
        // '--no-first-run', 
        // '--no-default-browser-check' 
    ]
  });
  
  await new Promise(resolve => setTimeout(resolve, 100000));

  console.log('Persistent context launched. Getting initial page...');
  // Get the initial page from the persistent context
  const page = context.pages()[0]; 
  if (!page) {
    console.error("Failed to get initial page from persistent context. Exiting.");
    await context.close();
    return; 
  }
  console.log('Initial page obtained.');

  try {
    // Read configuration using readConfig again
    const config = await readConfig(); 
    const eventPageUrl = config['EVENT_CALENDAR_URL'];
    if (!eventPageUrl) throw new Error(`EVENT_CALENDAR_URL not found in config.txt`);

    // --- Explicitly navigate to the Event Calendar URL --- 
    console.log(`Navigating to ${eventPageUrl}...`);
    await page.goto(eventPageUrl, { waitUntil: 'networkidle', timeout: 60000 }); // Wait for navigation and network idle
    console.log(`Successfully navigated to ${eventPageUrl}.`);
    // --- End Navigation --- 

    // --- Add Scrolling Logic Here ---
    console.log('Starting scroll to load all events...');
    await autoScroll(page);
    console.log('Scrolling complete.');
    // --- End Scrolling Logic ---

    // --- Event Scraping and Processing --- 
    console.log(`Waiting for event page to settle (networkidle)...`);
    await page.waitForLoadState('networkidle', { timeout: 15000 });
    console.log('Network idle detected. Processing event cards...');
    const eventCardLinkSelector = 'a.event-link';
    console.log(`Waiting for event card links using selector: ${eventCardLinkSelector}`);
    await page.waitForSelector(eventCardLinkSelector, { timeout: 20000 });

    const allEventLinks = await page.evaluate((selector) => {
      return Array.from(document.querySelectorAll(selector))
        .map(el => (el instanceof HTMLAnchorElement) ? el.href : null)
        .filter((href): href is string => href !== null);
    }, eventCardLinkSelector);
    console.log(`Found ${allEventLinks.length} total event links.`);

    // Loop through links and call the processor function
    for (const link of allEventLinks) {
        console.log(`\n--- Processing Event: ${link} ---`);
        const registrationSuccess = await processEventPage(page, context, link, config); // Get success status
        
        // --- Record result based on success status --- 
        if (registrationSuccess) {
             console.log(`Successfully processed ${link}.`);
        } else {
             console.warn(`Processing failed for ${link}. Recording in ${toRegisterFile}...`);
             await appendToRegisterFile(link); // Record failure in to_register.txt
        }
    }

    console.log('\n--- Finished processing all new events ---');

    await new Promise(resolve => setTimeout(resolve, 10000)); // Keep the pause
  } catch (error) {
    console.error('\x1b[31mAn error occurred in main execution:\x1b[0m', error);
  } finally {
    console.log('Closing browser...');
    await context.close();
    // rl.close(); // rl instances are closed after each prompt now
    console.log('Browser closed.');
  }
}

main(); 