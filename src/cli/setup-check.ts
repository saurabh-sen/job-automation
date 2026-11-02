/**
 * `npm run setup:check [-- --json] [-- --no-logins]`: checks every setup step in order and says how to fix the first
 * problems. The /setup skill runs it after each step. Read-only: it never launches Chrome, clicks, or prints config values.
 */
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { cdpUp, openBackgroundPage, profileOpenWithoutDebugging } from '../browser.js';
import { ADAPTERS } from '../adapters/index.js';
import { ConfigError, loadChromeConfig, loadTelegramConfig, parseConfig, readRawConfig, SITE_IDS, SITE_NAMES, type Config } from '../config.js';
import { acquireLock, releaseLock } from '../lock.js';
import { findChrome, osSupport } from '../platform.js';
import { Telegram } from '../telegram.js';
import { checkpointHit, errMsg } from '../utils.js';
import { scheduleStatus } from './schedule.js';

export type Check = { id: string; status: 'ok' | 'fail' | 'warn' | 'info' | 'skip'; message: string; fix?: string };

const ICON: Record<Check['status'], string> = { ok: '✅', fail: '❌', warn: '⚠️ ', info: 'ℹ️ ', skip: '⏭️ ' };

/** One line per check; the fix only for problems. */
export function formatChecks(checks: Check[]): string {
  const lines = checks.map((c) => `${ICON[c.status]} ${c.message}${c.fix && (c.status === 'fail' || c.status === 'warn') ? `\n     → ${c.fix}` : ''}`);
  const failed = checks.filter((c) => c.status === 'fail').length;
  lines.push('', failed ? `${failed} step(s) left. Fix the first ❌ and run \`npm run setup:check\` again.` : 'Setup complete.');
  return lines.join('\n');
}

/** Major version from "v20.11.1". */
export const nodeMajor = (v: string) => Number(/^v?(\d+)/.exec(v)?.[1] ?? 0);

async function checkDeps(): Promise<Check> {
  try {
    const { default: Database } = await import('better-sqlite3');
    new Database(':memory:').close();
    await import('playwright-core');
    return { id: 'deps', status: 'ok', message: 'Dependencies installed' };
  } catch (e) {
    return {
      id: 'deps', status: 'fail', message: `Dependencies missing or not built for this Node (${errMsg(e)})`,
      fix: 'Run `npm install`. On Windows, if better-sqlite3 fails to build, install "Desktop development with C++" from Visual Studio Build Tools, then retry.',
    };
  }
}

async function checkTelegram(): Promise<Check[]> {
  let tg: Config['telegram'];
  try {
    tg = loadTelegramConfig();
  } catch {
    return [{ id: 'telegram-token', status: 'fail', message: 'Telegram bot token not set', fix: 'Create a bot with @BotFather and paste its token into config.yaml → telegram.botToken.' }];
  }
  if (!tg.enabled) return [{ id: 'telegram-token', status: 'warn', message: 'Telegram is turned off: you will not get hand-offs or logout alerts', fix: 'Set telegram.enabled: true.' }];
  const bot = new Telegram(tg);
  let name: string;
  try {
    name = await bot.getBotName();
  } catch (e) {
    const offline = errMsg(e).startsWith('Could not reach');
    return [{
      id: 'telegram-token', status: 'fail', message: errMsg(e),
      fix: offline ? 'Check your internet connection (or a VPN/firewall blocking api.telegram.org) and run this again.'
        : 'Copy the token again from @BotFather (/mybots → your bot → API Token) into telegram.botToken.',
    }];
  }
  const checks: Check[] = [{ id: 'telegram-token', status: 'ok', message: `Telegram bot ${name} works` }];
  checks.push(tg.chatId
    ? { id: 'telegram-chat', status: 'ok', message: 'Telegram chat id set (`npm run telegram` sends a test message)' }
    : { id: 'telegram-chat', status: 'fail', message: 'Telegram chat id not set', fix: `Send any message to ${name} in Telegram, then run \`npm run telegram -- --save\`.` });
  return checks;
}

async function checkLogins(cfg: Config, cdpUrl: string): Promise<Check[]> {
  const sites = SITE_IDS.filter((id) => cfg.sites[id].enabled);
  if (!sites.length) return [{ id: 'logins', status: 'fail', message: 'No site is enabled', fix: 'Set sites.<site>.enabled: true for the sites you use.' }];
  if (!acquireLock()) return [{ id: 'logins', status: 'skip', message: 'Logins not checked: a run is in progress. Try again when it finishes.' }];
  const checks: Check[] = [];
  let browser;
  try {
    browser = await chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0];
    if (!context) throw new Error('the agent Chrome has no browser context');
    for (const id of sites) {
      const adapter = ADAPTERS[id];
      if (!adapter) continue;
      const page = await openBackgroundPage(browser, context);
      try {
        const ok = await adapter.isLoggedIn(page);
        if (await checkpointHit(page)) {
          checks.push({ id: `login-${id}`, status: 'fail', message: `${SITE_NAMES[id]}: a captcha or verification screen is showing`, fix: `Clear it yourself in the agent Chrome (\`npm run chrome\`).` });
        } else {
          checks.push(ok
            ? { id: `login-${id}`, status: 'ok', message: `${SITE_NAMES[id]}: logged in` }
            : { id: `login-${id}`, status: 'fail', message: `${SITE_NAMES[id]}: not logged in`, fix: `Log in to ${SITE_NAMES[id]} yourself in the agent Chrome (\`npm run chrome\`).` });
        }
      } catch (e) {
        checks.push({ id: `login-${id}`, status: 'warn', message: `${SITE_NAMES[id]}: could not check login (${errMsg(e)})`, fix: 'Open the site in the agent Chrome and check by eye.' });
      } finally {
        await page.close().catch(() => {});
      }
    }
  } catch (e) {
    checks.push({ id: 'logins', status: 'warn', message: `Could not check logins: ${errMsg(e)}` });
  } finally {
    await browser?.close().catch(() => {}); // disconnects only
    releaseLock();
  }
  return checks;
}

export async function runChecks(opts: { logins: boolean }): Promise<Check[]> {
  const checks: Check[] = [];
  const os = osSupport();
  checks.push(os.level === 'supported'
    ? { id: 'os', status: 'ok', message: `${os.name}` }
    : os.level === 'beta'
      ? { id: 'os', status: 'warn', message: `${os.name}: supported in beta (written and unit-tested, not yet run on a real machine)`, fix: 'Watch the first runs and the logs/ folder closely.' }
      : { id: 'os', status: 'fail', message: `${os.name} is not supported`, fix: 'Use macOS, Windows or Linux.' });

  const major = nodeMajor(process.version);
  checks.push(major >= 20
    ? { id: 'node', status: 'ok', message: `Node ${process.version}` }
    : { id: 'node', status: 'fail', message: `Node ${process.version} is too old`, fix: 'Install Node 20 or newer (https://nodejs.org), then `npm install`.' });
  checks.push(await checkDeps());

  let cfg: Config | null = null;
  if (!fs.existsSync('config.yaml')) {
    checks.push({ id: 'config', status: 'fail', message: 'config.yaml not found', fix: 'Copy config.example.yaml to config.yaml and fill it in (the /setup skill asks you the questions).' });
  } else {
    try {
      cfg = parseConfig(readRawConfig());
      checks.push({ id: 'config', status: 'ok', message: 'config.yaml complete' });
    } catch (e) {
      const problems = e instanceof ConfigError ? e.problems : [errMsg(e)];
      const nonTelegram = problems.filter((p) => !p.startsWith('telegram.'));
      // Telegram gaps get their own checks below; only the rest of the config is reported here.
      checks.push(nonTelegram.length
        ? { id: 'config', status: 'fail', message: `config.yaml needs: ${nonTelegram.join('; ')}`, fix: 'Fill these in config.yaml.' }
        : { id: 'config', status: 'ok', message: 'config.yaml complete apart from Telegram' });
    }
  }

  if (fs.existsSync('config.yaml')) checks.push(...(await checkTelegram()));

  let chrome: Config['chrome'] | null = null;
  try {
    chrome = fs.existsSync('config.yaml') ? loadChromeConfig() : null;
  } catch (e) {
    checks.push({ id: 'chrome', status: 'fail', message: errMsg(e) });
  }
  if (chrome) {
    try {
      checks.push({ id: 'chrome', status: 'ok', message: `Chrome found (${findChrome(chrome.executablePath)})` });
    } catch (e) {
      checks.push({ id: 'chrome', status: 'fail', message: errMsg(e), fix: 'Install Google Chrome (https://www.google.com/chrome), or set chrome.executablePath.' });
    }
    const up = await cdpUp(chrome.cdpUrl);
    if (up) {
      checks.push({ id: 'agent-chrome', status: 'ok', message: `Agent Chrome running (${chrome.userDataDir})` });
    } else if (profileOpenWithoutDebugging(chrome.userDataDir)) {
      checks.push({ id: 'agent-chrome', status: 'fail', message: 'The agent Chrome profile is open without remote debugging', fix: 'Quit that Chrome window, then run `npm run chrome`.' });
    } else {
      checks.push({ id: 'agent-chrome', status: 'fail', message: 'Agent Chrome is not running', fix: 'Run `npm run chrome` and log in to each enabled site in that window.' });
    }
    if (cfg && up && opts.logins) checks.push(...(await checkLogins(cfg, chrome.cdpUrl)));
    else if (cfg && !opts.logins) checks.push({ id: 'logins', status: 'skip', message: 'Logins not checked (--no-logins)' });
  }

  if (cfg) {
    const enabled = SITE_IDS.filter((id) => cfg.sites[id].enabled);
    const live = enabled.filter((id) => cfg.sites[id].live);
    checks.push({
      id: 'live', status: 'info',
      message: `Live (really applies): ${live.map((id) => SITE_NAMES[id]).join(', ') || 'none'}. Dry run only: ${enabled.filter((id) => !live.includes(id)).map((id) => SITE_NAMES[id]).join(', ') || 'none'}.`,
    });
  }

  const sched = scheduleStatus();
  checks.push(sched.installed
    ? { id: 'schedule', status: 'ok', message: `Schedule: ${sched.detail}` }
    : { id: 'schedule', status: 'fail', message: `Schedule not installed (${sched.detail})`, fix: 'After a dry run looks right, run `npm run schedule:install`.' });
  return checks;
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('src/cli/setup-check.ts');
if (isMain) {
  const checks = await runChecks({ logins: !process.argv.includes('--no-logins') });
  console.log(process.argv.includes('--json') ? JSON.stringify({ ok: !checks.some((c) => c.status === 'fail'), checks }, null, 2) : formatChecks(checks));
  process.exitCode = checks.some((c) => c.status === 'fail') ? 1 : 0;
}
