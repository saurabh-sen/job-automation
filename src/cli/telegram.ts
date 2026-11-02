/**
 * `npm run telegram`: with no chatId, lists the chats that messaged the bot; with a chatId, sends a test message.
 * `--save` writes the chat id into config.yaml when exactly one private chat messaged the bot.
 * Never prints the bot token.
 */
import fs from 'node:fs';
import YAML from 'yaml';
import { ConfigError, loadTelegramConfig, type Config } from '../config.js';
import { Telegram } from '../telegram.js';
import { errMsg } from '../utils.js';

/** Sets telegram.chatId in config.yaml, keeping its comments and layout. */
export function setChatId(yamlText: string, chatId: string): string {
  const doc = YAML.parseDocument(yamlText);
  doc.setIn(['telegram', 'chatId'], chatId);
  return doc.toString();
}

async function main(save: boolean): Promise<number> {
  let cfg: Config['telegram'];
  try {
    cfg = loadTelegramConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      console.error('Create a bot with @BotFather, put its token in config.yaml (telegram.botToken), then run this again.');
      return 1;
    }
    // First line only: a YAML parse error carries a code frame that could show config values.
    console.error(errMsg(e));
    return 1;
  }
  const tg = new Telegram(cfg);

  if (!cfg.chatId) {
    let chats: Awaited<ReturnType<Telegram['getChats']>>;
    try {
      chats = await tg.getChats();
    } catch (e) {
      console.error(errMsg(e));
      return 1;
    }
    if (!chats.length) {
      console.log('Send any message to your bot first, then run this again.');
      return 0;
    }
    const mine = chats.filter((c) => c.type === 'private');
    if (save && mine.length === 1) {
      fs.writeFileSync('config.yaml', setChatId(fs.readFileSync('config.yaml', 'utf8'), mine[0].id));
      console.log(`Saved telegram.chatId for ${mine[0].name}. Run \`npm run telegram\` again to send a test message.`);
      return 0;
    }
    if (save) console.log(`Can't save automatically: ${mine.length} private chats messaged the bot. Pick yours below.`);
    for (const c of chats) console.log(`chat id: ${c.id}  (${c.name}, ${c.type})`);
    console.log('\nPut your chat id in config.yaml as telegram.chatId (in quotes, e.g. chatId: "123456789"),');
    console.log('then run `npm run telegram` again to send a test message.');
    return 0;
  }

  if (!cfg.enabled) {
    console.log('Telegram is turned off (telegram.enabled: false in config.yaml). Set it to true to get hand-offs and summaries.');
    return 0;
  }
  const ok = await tg.send('<b>Job agent</b>\nTest message: Telegram is set up. Hand-offs and run summaries will arrive here.');
  if (ok) {
    console.log('Test message sent. Check Telegram.');
    return 0;
  }
  console.error(`Test message failed: ${tg.lastError ?? 'unknown error'}`);
  return 1;
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('src/cli/telegram.ts');
if (isMain) process.exitCode = await main(process.argv.includes('--save'));
