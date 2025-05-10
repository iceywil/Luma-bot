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
  const userDataDir = path.resolve(__dirname, '../playwright_chrome_profile'); // Using a dedicated profile directory
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
  

  console.log('Persistent context launched. Getting initial page...');
  // Get the initial page from the persistent context
  const page = context.pages()[0]; 
  if (!page) {
    console.error("Failed to get initial page from persistent context. Exiting.");
    await context.close();
    return; 
  }
  console.log('Initial page obtained.');

  const processingFailures: string[] = []; // Initialize array for failed events

  try {
    // --- Navigate to Login Page and Wait ---
    const loginUrl = 'https://lu.ma/signin';
    console.log(`Navigating to login page: ${loginUrl}...`);
    await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: 60000 });
    console.log(`Successfully navigated to ${loginUrl}. Please log in if prompted.`);
    
    // --- Wait for redirection to home page after login ---
    console.log('Waiting for redirection to https://lu.ma/home after login...');
    const homeUrl = 'https://lu.ma/home';
    const loginCheckTimeout = 180000; // 3 minutes timeout for login
    const checkInterval = 2000; // Check URL every 2 seconds
    let currentTime = 0;
    let loggedIn = false;

    while (currentTime < loginCheckTimeout) {
        if (page.url() === homeUrl) {
            console.log('Redirected to home page. Login successful.');
            loggedIn = true;
            break;
        }
        await page.waitForTimeout(checkInterval);
        currentTime += checkInterval;
        if (currentTime % 10000 === 0) { // Log every 10 seconds
            console.log(`Still waiting for login, current URL: ${page.url()} (${currentTime / 1000}s passed)`);
        }
    }

    if (!loggedIn) {
        console.warn(`Timed out waiting for login redirection to ${homeUrl} after ${loginCheckTimeout / 1000} seconds. Current URL: ${page.url()}. Proceeding anyway...`);
        // Optionally, you could throw an error here or handle it differently
        // For now, it will proceed as the old logic would have after the timeout
    }
    // --- End Login Step ---

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
             console.warn(`Processing failed for ${link}. Adding to failures list.`);
             // await appendToRegisterFile(link); // REMOVED: Record failure in to_register.txt
             processingFailures.push(link); // Add to in-memory list
        }
    }

    console.log('\n--- Finished processing all events ---');

    // Log failed events, if any
    if (processingFailures.length > 0) {
        console.warn(`\n--- The following ${processingFailures.length} event(s) failed processing: ---`);
        processingFailures.forEach(url => console.warn(`  - ${url}`));
    } else {
        console.log('\nAll events processed successfully or skipped as per criteria.');
    }

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