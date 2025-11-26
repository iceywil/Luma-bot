import { execSync, spawn } from 'child_process';

export async function promptAndOpen(urls: string[]) {
  if (!urls || urls.length === 0) return;
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = (q: string) => new Promise<string>(res => rl.question(q, res));
  const answer = (await question(`Open ${urls.length} tabs in Chrome? (y/N): `)).trim();
  rl.close();
  const yes = ['y', 'Y', 'yes', 'Yes'].includes(answer);
  if (!yes) {
    console.log('Not opening tabs.');
    return;
  }

  const candidates = ['google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium', 'chrome'];
  let found: string | null = null;
  for (const cmd of candidates) {
    try {
      execSync(`command -v ${cmd}`, { stdio: 'ignore' });
      found = cmd;
      break;
    } catch (_err) {
      // not found, continue
    }
  }

  if (found) {
    try {
      const child = spawn(found, urls, { detached: true, stdio: 'ignore' });
      child.unref();
      console.log(`Opened ${urls.length} tabs with ${found}`);
      return;
    } catch (err) {
      console.error('Failed to spawn Chrome:', err);
    }
  }

  // final fallback: use xdg-open for each URL
  for (const u of urls) {
    try {
      const c = spawn('xdg-open', [u], { detached: true, stdio: 'ignore' });
      c.unref();
    } catch (err) {
      // ignore
    }
  }
  console.log('Opened URLs with the default handler (xdg-open).');
}

export default promptAndOpen;
