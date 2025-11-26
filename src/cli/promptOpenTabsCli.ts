import promptAndOpen from '../utils/promptOpenTabs';

async function main() {
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('Paste URLs (one per line). Submit a blank line to finish:');
  const urls: string[] = [];

  for await (const line of rl) {
    const trimmed = (line as string).trim();
    if (trimmed === '') {
      rl.close();
      break;
    }
    urls.push(trimmed);
  }

  if (urls.length === 0) {
    console.log('No URLs provided. Exiting.');
    process.exit(0);
  }

  await promptAndOpen(urls);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
