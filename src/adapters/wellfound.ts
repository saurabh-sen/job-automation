import type { Locator, Page } from 'playwright-core';
import type { SiteAdapter, JobRef, JobDetails, ApplyOutcome } from './types.js';
import type { Question } from '../answers.js';
import { fillFields } from '../forms.js';
import { fillTemplate, TEMPLATE_LIMITS } from '../templates.js';
import { clean, isVisible, log, pause } from '../utils.js';

// Verified on 2026-11-02 (see Site notes in CLAUDE.md): feed, job page and the Apply modal (opened and cancelled).
// Not seen yet: a company-site job.
const BASE = 'https://wellfound.com';
const LOGIN_PATH = /\/login\b/;
const LOGGED_IN_NAV = /^(applied|messages)$/i;
/** Job links need the full slug: /jobs/<id> alone is a 404. */
const JOB_HREF = /href="(\/jobs\/(\d+)-[^"?#]+)/g;
const SCROLLS = 5;

/** Page title: "<role> at <company> • <location> | Wellfound". */
const TITLE_PATTERN = /^(.*) at (.*?)(?: • (.*?))? \| Wellfound$/;
const APPLY_NAME = /^apply( now)?$/i;
const APPLIED_NAME = /^applied$/i;
/** The modal is a ReactModal dialog with the job's facts, a note box and "Send application" / "Cancel". */
const SEND_NAME = /^send application$/i;
const CANCEL_NAME = /^cancel$/i;
const SUCCESS_TEXT = /your application has been sent|^success!/i;
/** The note box: "What interests you about working for this company?" (or a similar note to the hiring team). */
const NOTE_LABEL = /interests? you|why (do )?you want|note to|message to|cover letter|hiring team/i;

const applyButton = (page: Page) => page.locator('main, body').first().getByRole('button', { name: APPLY_NAME }).filter({ visible: true }).first();
const modal = (page: Page) => page.getByRole('dialog').filter({ visible: true }).first();

/** "AI Engineer at Steps AI • Hyderabad | Wellfound" -> parts. */
export function parseWellfoundTitle(t: string): { title: string; company: string; location: string } {
  const m = clean(t).match(TITLE_PATTERN);
  return m ? { title: m[1], company: m[2], location: m[3] ?? '' } : { title: '', company: '', location: '' };
}

/** Unique /jobs/<id>-<slug> links in a page's HTML, in order. */
export function wellfoundJobs(html: string): Array<{ id: string; path: string }> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(JOB_HREF)) if (!out.has(m[2])) out.set(m[2], m[1]);
  return [...out].map(([id, path]) => ({ id, path }));
}

/** The textarea whose question looks like a note to the hiring team. */
async function noteBox(dlg: Locator): Promise<Locator | null> {
  const boxes = dlg.locator('textarea');
  for (let i = 0; i < (await boxes.count()); i++) {
    const box = boxes.nth(i);
    // DOM boundary: the question text sits just before the textarea
    const label = await box.evaluate((el) => (el.closest('div')?.parentElement?.innerText ?? '').slice(0, 300)).catch(() => '');
    if (NOTE_LABEL.test(label)) return box;
  }
  return null;
}

export const wellfound: SiteAdapter = {
  id: 'wellfound',

  async isLoggedIn(page) {
    await page.goto(`${BASE}/jobs`, { waitUntil: 'domcontentloaded' });
    await pause(2500, 4000);
    if (LOGIN_PATH.test(new URL(page.url()).pathname)) return false;
    return isVisible(page.getByRole('link', { name: LOGGED_IN_NAV }));
  },

  async collectJobs(page, cfg) {
    const max = cfg.limits.maxJobsToScanPerSite;
    const refs = new Map<string, JobRef>();
    for (const url of cfg.sites.wellfound.discoveryUrls) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await pause(4000, 6000);
      for (let i = 0; i <= SCROLLS && refs.size < max; i++) {
        for (const j of wellfoundJobs(await page.content())) {
          if (!refs.has(j.id)) refs.set(j.id, { site: 'wellfound', jobId: j.id, url: new URL(j.path, BASE).toString() });
        }
        await page.mouse.wheel(0, 4000);
        await pause(2000, 3000);
      }
      if (!refs.size) log(`wellfound: no job links found on ${url} (layout may have changed)`);
      if (refs.size >= max) break;
    }
    return [...refs.values()].slice(0, max);
  },

  async getDetails(page, ref): Promise<JobDetails> {
    await page.goto(ref.url, { waitUntil: 'domcontentloaded' });
    await page.locator('h1').first().waitFor({ timeout: 15_000 }).catch(() => {});
    await pause();

    const { title, company, location } = parseWellfoundTitle(await page.title());
    const body = await page.locator('main, body').first().innerText({ timeout: 5000 }).catch(() => '');
    const salary = body.match(/[₹$€£][\d.,]+[kKLM]?\s*[–-]\s*[₹$€£]?[\d.,]+[kKLM]?/)?.[0];
    const postedAt = body.match(/Posted ([^\n]*?ago)/i)?.[1];
    const h1 = await page.locator('h1').first().innerText({ timeout: 3000 }).catch(() => '');
    const start = body.indexOf(h1);
    const description = (start >= 0 ? body.slice(start + h1.length) : body).trim().slice(0, 20000);

    let applyType: JobDetails['applyType'] = 'unknown';
    const apply = applyButton(page);
    if (await isVisible(page.locator('main, body').first().getByRole('button', { name: APPLIED_NAME }))) applyType = 'already_applied';
    else if (await isVisible(apply)) applyType = 'in_site';
    else if (await isVisible(page.getByRole('link', { name: APPLY_NAME }))) applyType = 'company_site';

    return { ...ref, title, company, location, salary, postedAt, description, applyType };
  },

  async apply(page, job, ctx): Promise<ApplyOutcome> {
    const button = applyButton(page);
    if (!(await isVisible(button))) return { status: 'failed', reason: 'SELECTOR_MISSING', detail: 'no Apply button' };
    await button.click();
    const dlg = modal(page);
    if (!(await dlg.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false))) {
      return { status: 'failed', reason: 'SELECTOR_MISSING', detail: 'Apply modal did not open' };
    }
    await pause();

    const note = await noteBox(dlg);
    if (note && !clean(await note.inputValue().catch(() => ''))) {
      const text = fillTemplate(ctx.cfg.templates.wellfound, { firstName: ctx.cfg.profile.firstName, company: job.company, role: job.title },
        TEMPLATE_LIMITS.wellfound);
      await note.fill(text);
      await pause();
    }
    const { missing } = await fillFields(page, dlg, ctx.answers);
    if (missing.length) {
      await wellfound.abandon(page);
      return { status: 'needs_review', reason: 'UNANSWERED_QUESTIONS', detail: missing.map((q: Question) => q.label).join('\n') };
    }

    const send = dlg.getByRole('button', { name: SEND_NAME }).first();
    // the modal animates in, so wait for the button instead of checking once
    if (!(await send.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false))) {
      return { status: 'failed', reason: 'SELECTOR_MISSING', detail: 'no Send application button' };
    }
    if (ctx.dryRun) {
      await wellfound.abandon(page);
      return { status: 'applied', detail: 'dry-run' };
    }
    await send.click();
    // success (verified 2026-11-02): the modal stays open and says "Success! Your application has been sent."
    const sent = await dlg.getByText(SUCCESS_TEXT).first().waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false);
    await pause();
    await page.keyboard.press('Escape').catch(() => {});
    if (sent) return { status: 'applied' };
    return { status: 'failed', reason: 'NO_CONFIRMATION', detail: 'no confirmation after Send application' };
  },

  async abandon(page) {
    const dlg = modal(page);
    if (!(await isVisible(dlg))) return;
    const cancel = dlg.getByRole('button', { name: CANCEL_NAME }).first();
    if (await isVisible(cancel)) await cancel.click().catch(() => {});
    else await page.keyboard.press('Escape').catch(() => {});
    await pause(500, 1000);
  },
};
