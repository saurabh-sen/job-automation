import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from 'playwright-core';
import type { SiteId } from './config.js';
import { errMsg, isVisible, localDate, log } from './utils.js';

const safeName = (s: string) => s.replace(/[^a-z0-9._-]/gi, '_').slice(0, 80) || 'job';

/**
 * Saves logs/failures/<date>/<site>-<jobId>.png (full page) and .html (the modal if given and visible, else the page).
 * Returns the base path (without extension), or null when nothing could be written. Never throws.
 */
export async function saveFailure(page: Page, site: SiteId, jobId: string, scope?: Locator, dir = 'logs/failures'): Promise<string | null> {
  let base: string;
  try {
    const day = path.resolve(dir, localDate());
    fs.mkdirSync(day, { recursive: true });
    base = path.join(day, `${site}-${safeName(jobId)}`);
  } catch (e) {
    log(`Could not create the failure folder: ${errMsg(e)}`);
    return null;
  }
  let wrote = false;
  try {
    await page.screenshot({ path: `${base}.png`, fullPage: true, timeout: 15_000 });
    wrote = true;
  } catch (e) {
    log(`Failure screenshot not saved: ${errMsg(e)}`);
  }
  try {
    const html = scope && (await isVisible(scope))
      ? await scope.first().evaluate((el) => el.outerHTML, undefined, { timeout: 5000 })
      : await page.content();
    fs.writeFileSync(`${base}.html`, html);
    wrote = true;
  } catch (e) {
    log(`Failure HTML not saved: ${errMsg(e)}`);
  }
  return wrote ? base : null;
}
