import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import type { Config } from './config.js';
import { findChrome } from './platform.js';
import { log, sleep } from './utils.js';

type ChromeCfg = Config['chrome'];

/** True when Chrome answers on the DevTools endpoint. */
export async function cdpUp(cdpUrl: string): Promise<boolean> {
  try {
    const res = await fetch(new URL('/json/version', cdpUrl), { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

const portOf = (cdpUrl: string) => new URL(cdpUrl).port || '9222';

/**
 * True when another Chrome already holds this profile (macOS/Linux SingletonLock symlink "<host>-<pid>" with a live pid).
 * Windows has no such symlink, so there it is always false and a failed attach reports the problem instead.
 * Chrome started that way has no debugging port, and launching again would just hand the URLs to it.
 */
export function profileOpenWithoutDebugging(userDataDir: string): boolean {
  try {
    const target = fs.readlinkSync(path.join(userDataDir, 'SingletonLock'));
    const pid = Number(/-(\d+)$/.exec(target)?.[1]);
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  } catch {
    return false;
  }
}

/**
 * The agent works in windows behind whatever you're using. Chrome normally pauses or throttles hidden and covered
 * windows (which makes clicks hang), so these keep them running at full speed.
 */
export const BACKGROUND_FLAGS = [
  '--disable-backgrounding-occluded-windows',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
];

/**
 * Starts the real Chrome on the agent's dedicated profile with remote debugging enabled.
 * `foreground: false` (scheduled runs) launches it without activating it, so it never takes focus.
 */
export function launchChrome(chrome: ChromeCfg, urls: string[] = [], { foreground = true } = {}): void {
  const exe = findChrome(chrome.executablePath);
  fs.mkdirSync(chrome.userDataDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${portOf(chrome.cdpUrl)}`,
    `--user-data-dir=${chrome.userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...BACKGROUND_FLAGS,
    // in the background, Chrome must not open (and activate) a startup window; the agent opens its own, unfocused
    ...(foreground ? urls : ['--no-startup-window']),
  ];
  // macOS: `open -g` starts the app without bringing it to the front; -n gives the agent profile its own instance
  // Windows and Linux start Chrome directly; with --no-startup-window it has no window until the agent opens one.
  const app = process.platform === 'darwin' ? exe.match(/^(.*?\.app)\//)?.[1] : undefined;
  const child = app
    ? spawn('open', [...(foreground ? [] : ['-g']), '-n', '-a', app, '--args', ...args], { detached: true, stdio: 'ignore' })
    : spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: !foreground });
  child.on('error', (e) => log(`Could not start Chrome: ${e.message}`));
  child.unref();
}

/** Attaches to the agent Chrome over CDP, launching it first if needed, so the logged-in sessions are reused. */
export async function connectBrowser(chrome: ChromeCfg): Promise<Browser> {
  if (!(await cdpUp(chrome.cdpUrl))) {
    if (profileOpenWithoutDebugging(chrome.userDataDir)) {
      throw new Error('The agent Chrome profile is open without remote debugging. Quit that Chrome window, then run `npm run chrome`.');
    }
    log('Agent Chrome is not running; launching it in the background...');
    launchChrome(chrome, [], { foreground: false });
    const deadline = Date.now() + 30_000;
    while (!(await cdpUp(chrome.cdpUrl))) {
      if (Date.now() > deadline) {
        throw new Error(`Chrome did not open remote debugging at ${chrome.cdpUrl} within 30s. Run \`npm run chrome\` and check that window.`);
      }
      await sleep(1000);
    }
  }
  return chromium.connectOverCDP(chrome.cdpUrl);
}

/**
 * A new tab in its own window, opened in the background so it never takes focus from what you're working on.
 * (Playwright's context.newPage() brings Chrome to the front on macOS.)
 */
export async function openBackgroundPage(browser: Browser, context: BrowserContext): Promise<Page> {
  const cdp = await browser.newBrowserCDPSession();
  try {
    const created = context.waitForEvent('page', { timeout: 15_000 });
    await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true, background: true });
    return await created;
  } finally {
    await cdp.detach().catch(() => {});
  }
}
