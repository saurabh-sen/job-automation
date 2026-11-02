import type { Page } from 'playwright-core';
import type { SiteAdapter, JobRef, JobDetails, ApplyOutcome } from './types.js';
import type { Question } from '../answers.js';
import { fillFields } from '../forms.js';
import { clean, isVisible, log, pause, sleep } from '../utils.js';

// Verified read-only on 2026-11-02 (see Site notes in CLAUDE.md). The page after a real "Apply now" click is not seen yet.
// Instahyre is an AngularJS app: the feed's job ids and URLs come from each card's Angular scope.
const BASE = 'https://www.instahyre.com';
const FEED_URL = `${BASE}/candidate/opportunities/`;
const LOGIN_PATH = /\/login\b/;
const SIGN_OUT_NAME = /^sign out$/i;
/** Recommended-job cards on the feed (30 per page). */
const CARD = '.employer-block';
/** Feed page links ("1", "2", "3"). */
const PAGE_LINK = '[ng-repeat^="pageNumber in pages"]';

/** Job page: h1 = title, h2 = "at <company>", then "<locations> <N-M Years>". */
const TITLE = 'h1';
const COMPANY = 'h2';
const DESCRIPTION_HEADING = 'Job Description';
/** One-click apply: submits on click. */
const APPLY_NAME = /^apply now$/i;
const APPLIED_TEXT = /^(applied|application sent|you have applied|already applied)\b/i;
const QUESTION_MODAL = '.modal:visible, [role="dialog"]:visible';

interface FeedJob { id: string; url: string; title: string; company: string; locations: string }

/** "Bangalore 2-6 Years" -> "2-6 Years". */
export function experienceIn(text: string): string | undefined {
  return clean(text).match(/\d+\s*(?:-|–|to)\s*\d+\s*years?|\d+\+?\s*years?/i)?.[0];
}

/** "at BlueStone.com" -> "BlueStone.com". */
export const companyFromHeading = (h2: string) => clean(h2).replace(/^at\s+/i, '');

/** Text under "Job Description", up to the next section heading. */
export function descriptionFrom(text: string): string {
  const start = text.indexOf(DESCRIPTION_HEADING);
  if (start < 0) return '';
  const body = text.slice(start + DESCRIPTION_HEADING.length);
  const end = body.search(/\n\s*(About\s+\S.*|Similar jobs|More jobs)\s*\n/);
  return (end < 0 ? body : body.slice(0, end)).trim();
}

/** Jobs on the current feed page, read from each card's Angular scope (string, not a function: tsx wraps named helpers). */
async function feedJobs(page: Page): Promise<FeedJob[]> {
  // DOM/JSON boundary: Angular scope objects are untyped
  const raw = (await page.evaluate(`(() => {
    if (!window.angular) return [];
    return [...document.querySelectorAll(${JSON.stringify(CARD)})].map((el) => {
      const s = window.angular.element(el).scope();
      const j = s && s.opp && s.opp.job;
      return j ? { id: String(j.id), url: j.opportunity_url || '', title: j.title || j.candidate_title || '', company: j.hiring_company_name || '', locations: j.locations || '' } : null;
    }).filter(Boolean);
  })()`)) as FeedJob[];
  return raw.filter((j) => /^\d+$/.test(j.id) && j.url);
}

export const instahyre: SiteAdapter = {
  id: 'instahyre',

  async isLoggedIn(page) {
    await page.goto(FEED_URL, { waitUntil: 'domcontentloaded' });
    await pause(2000, 3000);
    if (LOGIN_PATH.test(new URL(page.url()).pathname)) return false;
    return isVisible(page.getByRole('link', { name: SIGN_OUT_NAME }));
  },

  async collectJobs(page, cfg) {
    const max = cfg.limits.maxJobsToScanPerSite;
    const refs = new Map<string, JobRef>();
    for (const url of cfg.sites.instahyre.discoveryUrls) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.locator(CARD).first().waitFor({ timeout: 15_000 }).catch(() => {});
      await pause(1500, 3000);
      const pages = Math.max(1, await page.locator(PAGE_LINK).count());
      for (let p = 0; p < pages && refs.size < max; p++) {
        if (p > 0) {
          // page links only switch the list (no applying)
          await page.locator(PAGE_LINK).nth(p).click().catch(() => {});
          await pause(2500, 4000);
        }
        const jobs = await feedJobs(page);
        if (!jobs.length && p === 0) log(`instahyre: no jobs found on ${url} (layout may have changed)`);
        for (const j of jobs) {
          if (!refs.has(j.id)) refs.set(j.id, { site: 'instahyre', jobId: j.id, url: new URL(j.url, BASE).toString() });
        }
      }
      if (refs.size >= max) break;
    }
    return [...refs.values()].slice(0, max);
  },

  async getDetails(page, ref): Promise<JobDetails> {
    await page.goto(ref.url, { waitUntil: 'domcontentloaded' });
    await page.locator(TITLE).first().waitFor({ timeout: 15_000 }).catch(() => {});
    await pause();

    const title = clean(await page.locator(TITLE).first().innerText({ timeout: 3000 }).catch(() => ''));
    const company = companyFromHeading(await page.locator(COMPANY).filter({ hasText: /^\s*at\s/i }).first().innerText({ timeout: 3000 }).catch(() => ''));
    const body = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    // the line right after "at <company>" holds "<locations> <N-M Years>"
    const afterCompany = company ? body.slice(body.indexOf(`at ${company}`) + company.length + 3, body.indexOf(DESCRIPTION_HEADING)) : '';
    const experience = experienceIn(afterCompany);
    const location = clean(afterCompany.replace(experience ?? '', '').replace(/apply now/i, ''));
    const description = descriptionFrom(body);

    let applyType: JobDetails['applyType'] = 'unknown';
    if (await isVisible(page.getByRole('button', { name: APPLIED_TEXT }))) applyType = 'already_applied';
    else if (await isVisible(page.getByRole('button', { name: APPLY_NAME }))) applyType = 'in_site';

    return { ...ref, title, company, location, experience, description, applyType };
  },

  async apply(page, _job, ctx): Promise<ApplyOutcome> {
    // "Apply now" submits on click, so a dry run must not click anything at all.
    if (ctx.dryRun) return { status: 'applied', detail: 'dry-run: stopped before Apply now (Instahyre submits on click)' };

    const button = page.getByRole('button', { name: APPLY_NAME }).filter({ visible: true }).first();
    if (!(await isVisible(button))) return { status: 'failed', reason: 'SELECTOR_MISSING', detail: 'no Apply now button' };
    // the button sits inside an <a> wrapper that Playwright says "intercepts pointer events"; a click at the button's
    // position (what a person does) is what applies, so skip that actionability check
    await button.click({ force: true });

    const end = Date.now() + 12_000;
    while (Date.now() < end) {
      const modal = page.locator(QUESTION_MODAL).first();
      if (await isVisible(modal)) {
        const { missing } = await fillFields(page, modal, ctx.answers);
        if (missing.length) {
          await instahyre.abandon(page);
          return { status: 'needs_review', reason: 'UNANSWERED_QUESTIONS', detail: missing.map((q: Question) => q.label).join('\n') };
        }
        // a question modal after the click: anything beyond filling it is unverified, so hand it to the user
        await instahyre.abandon(page);
        return { status: 'failed', reason: 'UNKNOWN', detail: 'a form appeared after Apply now; check this job by hand' };
      }
      // the button turns into an "Applied" state or goes away; description text is never used as a signal
      if (!(await isVisible(button)) || (await isVisible(page.getByRole('button', { name: APPLIED_TEXT })))) {
        return { status: 'applied' };
      }
      await sleep(500);
    }
    return { status: 'failed', reason: 'NO_CONFIRMATION', detail: 'no confirmation after Apply now' };
  },

  async abandon(page) {
    await page.keyboard.press('Escape').catch(() => {});
    await pause(500, 1000);
  },
};
