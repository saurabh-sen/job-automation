import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from 'playwright-core';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const rand = (min: number, max: number) => Math.floor(min + Math.random() * (max - min + 1));
export const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 300);

/** Local calendar date, YYYY-MM-DD. */
export const localDate = (d = new Date()) => d.toLocaleDateString('en-CA');

let actionDelay: [number, number] = [500, 2000];
/** Set once per run from config.limits.actionDelayMs. */
export function setActionDelay(range: [number, number]) {
  actionDelay = range;
}

/** Human-like jittered pause between UI actions. Defaults to limits.actionDelayMs. */
export const pause = (min = actionDelay[0], max = actionDelay[1]) => sleep(rand(min, max));

let logFile: string | null = null;
/** Also append log lines to logs/run-YYYY-MM-DD.log from now on. */
export function enableFileLog(dir = 'logs') {
  fs.mkdirSync(dir, { recursive: true });
  logFile = path.resolve(dir, `run-${localDate()}.log`);
}

export function log(...parts: unknown[]) {
  const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  console.log(line);
  if (logFile) fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
}

/** One console line per job, e.g. `APPLIED  Frontend Engineer @ Acme (naukri)`. */
export function jobLine(label: string, job: { title?: string | null; company?: string | null; site: string }, extra = '') {
  const what = `${job.title || '?'} @ ${job.company || '?'} (${job.site})`;
  return `${label.toUpperCase().padEnd(13)}${what}${extra ? `: ${extra}` : ''}`;
}

export async function isVisible(loc: Locator) {
  return loc.first().isVisible().catch(() => false);
}

/** First non-empty innerText among the selectors. */
export async function textOf(scope: Page | Locator, selectors: string[], timeout = 2000): Promise<string> {
  for (const sel of selectors) {
    const loc = scope.locator(sel).first();
    if ((await loc.count().catch(() => 0)) === 0) continue;
    const text = await loc.innerText({ timeout }).catch(() => '');
    if (text.trim()) return text.trim();
  }
  return '';
}

/** Captcha, "verify you're human", login wall or unusual-activity screen: stop the site instead of pushing through. */
export async function checkpointHit(page: Page): Promise<boolean> {
  if (/checkpoint|captcha|challenge|authwall/i.test(page.url())) return true;
  if (await isVisible(page.locator('iframe[src*="captcha" i], iframe[title*="challenge" i], iframe[src*="turnstile" i]'))) return true;
  return isVisible(page.getByText(/verify (that )?you are (a )?human|security verification|unusual activity|are you a robot/i));
}
