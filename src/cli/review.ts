import readline from 'node:readline/promises';
import { JobDb } from '../db.js';

/** `npm run review`: answer queued screening questions once; they're reused for future jobs. */
async function main() {
  const db = new JobDb();
  try {
    const pending = db.listPending();
    if (!pending.length) {
      console.log('No questions waiting.');
      return;
    }

    console.log(`${pending.length} question(s). Type an answer (or an option number), Enter to skip, "-" to drop.\n`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Ctrl-D / end of piped input: stop asking instead of hanging on a question that can never be answered
    let ended = false;
    const end = new Promise<null>((resolve) => rl.once('close', () => { ended = true; resolve(null); }));
    let saved = 0;
    try {
      for (const p of pending) {
        if (ended) break;
        let options: string[] = [];
        try {
          // JSON boundary: options were stored as a JSON string[]
          const parsed: unknown = JSON.parse(p.options || '[]');
          if (Array.isArray(parsed)) options = parsed.map(String);
        } catch {
          // bad row: show it without options
        }
        console.log(`\nQ: ${p.question}`);
        options.forEach((o, i) => console.log(`   ${i + 1}. ${o}`));
        console.log(`   (${p.job_url})`);
        const reply = await Promise.race([rl.question('> '), end]);
        if (reply == null) break;
        const input = reply.trim();
        if (input === '-') db.deletePending(p.key);
        else if (input) {
          const n = Number(input);
          const answer = options.length && Number.isInteger(n) && n >= 1 && n <= options.length ? options[n - 1] : input;
          db.saveAnswer(p.question, answer, 'you');
          saved++;
        }
      }
    } finally {
      rl.close();
    }
    console.log(saved ? `\nSaved ${saved}. These answers are reused automatically from now on.` : '\nNothing saved.');
  } finally {
    db.close();
  }
}

await main();
