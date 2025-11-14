import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { readConfig, readProfile } from '../api_flow/config'; // Adjusted path
import { processEventPage } from './eventProcessor'; // Adjusted path
import * as fs from 'fs/promises';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, './.env') }); // Ensure .env is loaded from project root if test_main is in root

const toRegisterFile = 'to_register_test.txt'; // Use a different file for test to avoid conflicts

async function appendToRegisterFileTest(eventUrl: string): Promise<void> {
    try {
        await fs.appendFile(toRegisterFile, eventUrl + '\n', 'utf8');
        console.log(`  -> Appended failed event URL to ${toRegisterFile}`);
    } catch (err) {
        console.error(`\x1b[31mError writing failed event to ${toRegisterFile}:\x1b[0m`, err);
    }
}

async function testMain() {
  // Apply stealth plugin
  const stealthPlugin = stealth();
  chromium.use(stealthPlugin);

  const userDataDir = path.resolve(__dirname, './playwright_chrome_profile'); // Profile in project root
  const executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; // Adjust if necessary

  console.log(`Launching Chrome (${executablePath}) with profile (${userDataDir}) using stealth...`);
  
  const context = await chromium.launchPersistentContext(userDataDir, { 
    headless: false,
    executablePath: executablePath,
    args: ['--disable-blink-features=AutomationControlled']
  });
  
  console.log('Persistent context launched. Getting initial page...');
  const page = context.pages()[0]; 
  if (!page) {
    console.error("Failed to get initial page from persistent context. Exiting.");
    await context.close();
    return; 
  }
  console.log('Initial page obtained.');

  try {
    // --- Navigate to Login Page and Wait ---
    const loginUrl = 'https://lu.ma/signin';
    console.log(`Navigating to login page: ${loginUrl}...`);
    await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: 60000 });
    console.log(`Successfully navigated to ${loginUrl}. Please log in if prompted.`);
    
    const homeUrl = 'https://lu.ma/home';
    console.log(`Waiting for redirection to ${homeUrl} after login...`);
    const loginCheckTimeout = 180000; // 3 minutes
    const checkInterval = 2000;
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
        if (currentTime % 10000 === 0) {
            console.log(`Still waiting for login, current URL: ${page.url()} (${currentTime / 1000}s passed)`);
        }
    }

    if (!loggedIn) {
        console.warn(`Timed out waiting for login redirection to ${homeUrl}. Proceeding anyway...`);
    }
    // --- End Login Step ---

    const config = await readConfig(); 
    // const profile = await readProfile(); // readProfile is called within processEventPage

    const testEventUrl = 'https://lu.ma/bncannes';
    console.log(`\n--- Processing Single Test Event: ${testEventUrl} ---`);
    
    // Navigate to the event page using the main page object from the context
    // processEventPage now handles its own page creation for the event processing.
    // So, we don't navigate here. processEventPage will open a new page for the event.

    const registrationSuccess = await processEventPage(page, context, testEventUrl, config);
        
    if (registrationSuccess) {
         console.log(`Successfully processed ${testEventUrl}.`);
    } else {
         console.warn(`Processing failed for ${testEventUrl}. Recording in ${toRegisterFile}...`);
         await appendToRegisterFileTest(testEventUrl);
    }

    console.log('\n--- Test finished ---');
    await new Promise(resolve => setTimeout(resolve, 10000)); // Pause to observe

  } catch (error) {
    console.error('\x1b[31mAn error occurred in test execution:\x1b[0m', error);
  } finally {
    console.log('Closing browser...');
    await context.close();
    console.log('Browser closed.');
  }
}

testMain(); 