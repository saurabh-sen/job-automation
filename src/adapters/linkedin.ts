import type { Locator, Page } from 'playwright-core';
import type { SiteAdapter, JobRef, JobDetails, ApplyOutcome } from './types.js';
import type { Question } from '../answers.js';
import { fillFields, fixLpaFields } from '../forms.js';
import { clean, isVisible, pause } from '../utils.js';
import { readCompanySiteUrl } from './naukri.js';

// The preselected resume is left as it is; there is no resume handling here.
// Verified read-only on 2026-11-02. LinkedIn's new layout has hashed class names, so everything below uses accessible
// names, the page title and job ids found in the HTML. The Easy Apply modal itself is still unverified.
const FEED_URL = 'https://www.linkedin.com/feed/';
const LOGGED_IN_PATH = /^\/feed\b/;
const PAGE_STARTS = [0, 25];
/** Job ids in the HTML: search cards (componentkey), recommended cards (data-occludable-job-id) and /jobs/view/ links. */
const JOB_ID_PATTERNS = [/job-card-component-ref-(\d{6,})/g, /data-(?:occludable-)?job-id="(\d{6,})"/g, /\/jobs\/view\/(\d{6,})/g];
const jobViewUrl = (id: string) => `https://www.linkedin.com/jobs/view/${id}/`;

/** Page title is "<job title> | <company> | LinkedIn". */
const PRIMARY = { role: 'region', name: 'Primary content' } as const;
/** "Hyderabad, Telangana, India · 3 days ago · Over 100 applicants" */
const TOP_CARD_LINE = /·/;
/** Links named "On-site" / "Remote" / "Hybrid" / "Full-time", plus pay when shown. */
const PILL_LINK = /^(on-?site|remote|hybrid|full-time|part-time|contract|internship|[₹$€£].*)$/i;
const DESCRIPTION_HEADING = 'About the job';
/** An applied job shows this heading ("Applied on company site", "Application submitted ..."). */
const APPLICATION_STATUS_HEADING = 'Application status';

const EASY_APPLY_NAME = /easy apply/i; // "Easy Apply to this job"
/** Company-site link: "Apply on company website"; never matches "Easy Apply" or "Applied". */
const COMPANY_APPLY_NAME = /^apply\b/i;
/** "Applied 3 days ago", "Applied an hour ago", "Application submitted"; a bare "Applied" chip does not match. */
export const ALREADY_APPLIED_TEXT = /^(Applied (\d+|an?|a few) \w+ ago\b|Application submitted\b)/i;

const MODAL = '.jobs-easy-apply-modal';
const FOLLOW_CHECKBOX = 'input#follow-company-checkbox';
const FOLLOW_LABEL = 'label[for="follow-company-checkbox"]';
/** The modal is a native <dialog> named "Apply to <company>" with "Next" / "Review" / "Submit application" buttons (2026-11-02). */
const MODAL_NAME = /^apply to\b/i;
const SUBMIT_NAME = /^submit( application)?$/i;
const NEXT_NAME = /^(next|review|continue)\b/i;
const FOLLOW_NAME = /^follow\b/i;
const STEP_BUTTON_NAME = /^(next|review|continue|submit)\b/i;
/** Inline validation errors: old class, ARIA alerts, or the usual wording. */
const INLINE_ERROR = '.artdeco-inline-feedback--error, [role="alert"]';
// error wording only: field labels such as "Please select your category" must not count as errors
const ERROR_TEXT = /\bis required\b|please make a selection|enter a (valid|whole|decimal)|please enter a valid/i;
const SUBMITTED_TEXT = /application was sent|application submitted/i;
const DISMISS_NAME = 'Dismiss';
const DONE_NAME = /^done$/i;
const DISCARD_NAME = /^discard$/i;
const MAX_STEPS = 12;

// Only the job's own apply controls: "similar jobs" cards further down also say "Easy Apply" and link elsewhere.
const primaryContent = (page: Page) => page.getByRole(PRIMARY.role, { name: PRIMARY.name });
const easyApplyButton = (page: Page) =>
  primaryContent(page).getByRole('button', { name: EASY_APPLY_NAME }).filter({ visible: true }).first();
const companyApplyButton = (page: Page) =>
  primaryContent(page).getByRole('button', { name: COMPANY_APPLY_NAME })
    .or(primaryContent(page).getByRole('link', { name: COMPANY_APPLY_NAME }))
    .filter({ visible: true }).first();
const easyApplyModal = (page: Page) =>
  page.getByRole('dialog', { name: MODAL_NAME }).or(page.locator(MODAL)).filter({ visible: true }).first();

const POSTED = /\bago\b|^(re)?posted\b|^just now$/i;
const APPLICANTS = /applicants?\b|clicked apply/i;

/** Splits LinkedIn's " · " top-card line into location, posted time and applicant count. */
export function parseTopCard(text: string, company = ''): { location: string; postedAt?: string; applicants?: string } {
  const parts = (text ?? '').split(/\s*[·•]\s*|\n+/).map(clean).filter(Boolean);
  const out: { location: string; postedAt?: string; applicants?: string } = { location: '' };
  for (const p of parts) {
    if (POSTED.test(p)) out.postedAt ??= p;
    else if (APPLICANTS.test(p)) out.applicants ??= p;
    else if (!out.location && p.toLowerCase() !== company.trim().toLowerCase()) out.location = p;
  }
  return out;
}

/** First pill that is a workplace type, e.g. "Hybrid". */
export function workplaceType(pills: string[]): string | undefined {
  for (const p of pills) {
    const text = clean(p);
    const m = text.length <= 80 ? text.match(/\b(remote|hybrid|on-?site)\b/i) : null;
    if (m) return m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  }
  return undefined;
}

/** "Sr Associate Software Engineer | Amgen | LinkedIn" -> title and company (titles may contain " | "). */
export function parsePageTitle(t: string): { title: string; company: string } {
  const parts = (t ?? '').replace(/^\(\d+\)\s*/, '').split(' | ').map(clean);
  if (parts.length && /^linkedin$/i.test(parts[parts.length - 1])) parts.pop();
  if (parts.length < 2) return { title: parts[0] ?? '', company: '' };
  return { title: parts.slice(0, -1).join(' | '), company: parts[parts.length - 1] };
}

/** The company's own URL from LinkedIn's "safety/go/?url=..." redirect link, or a direct off-site link. */
export function externalApplyUrl(href: string | null | undefined): string | undefined {
  if (!href) return undefined;
  try {
    const u = new URL(href, 'https://www.linkedin.com');
    const wrapped = u.pathname.startsWith('/safety/go') ? u.searchParams.get('url') : null;
    const target = new URL(wrapped ?? u.toString());
    if (!/^https?:$/.test(target.protocol) || /(^|\.)linkedin\.com$/.test(target.hostname)) return undefined;
    return target.toString();
  } catch {
    return undefined;
  }
}

/** Text under "About the job" in the job's main section, up to the next section heading. */
export function descriptionFrom(primaryText: string): string {
  const start = primaryText.indexOf(DESCRIPTION_HEADING);
  if (start < 0) return '';
  const body = primaryText.slice(start + DESCRIPTION_HEADING.length);
  const end = body.search(/\n\s*(Set alert for similar jobs|Unlock hiring insights|About the company|People you can reach out to|More jobs)\b/);
  return (end < 0 ? body : body.slice(0, end)).trim();
}

/** All job ids in a page's HTML, in order of first appearance. */
export function jobIdsIn(html: string): string[] {
  const found: Array<[number, string]> = [];
  for (const re of JOB_ID_PATTERNS) for (const m of html.matchAll(re)) found.push([m.index ?? 0, m[1]]);
  return [...new Set(found.sort((a, b) => a[0] - b[0]).map(([, id]) => id))];
}

/** First pill that looks like pay, e.g. "₹15L/yr - ₹25L/yr". */
export function salaryPill(pills: string[]): string | undefined {
  return pills.map(clean).find((p) => /[₹$€£]|\blpa\b|\/(yr|year|mo|month|hr)\b/i.test(p));
}

/** Dismiss the Easy Apply modal, then Discard. Never touches Submit. */
async function abandonEasyApply(page: Page) {
  const dlg = easyApplyModal(page);
  if (!(await isVisible(dlg))) return;
  const dismiss = dlg.getByRole('button', { name: DISMISS_NAME }).first();
  if (!(await isVisible(dismiss))) return;
  await dismiss.click().catch(() => {});
  const discard = page.getByRole('button', { name: DISCARD_NAME }).first();
  await discard.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  if (await isVisible(discard)) await discard.click().catch(() => {});
  await pause(500, 1000);
}

/**
 * Unticks "Follow <company>" on the review step. The input is visually hidden right above Submit, so it is never
 * clicked by position: click its label, or dispatch the click on the input itself.
 */
async function unfollowCompany(dlg: Locator) {
  const box = dlg.locator(FOLLOW_CHECKBOX).or(dlg.getByRole('checkbox', { name: FOLLOW_NAME })).first();
  if ((await box.count().catch(() => 0)) === 0) return;
  if (!(await box.isChecked().catch(() => false))) return;
  const label = dlg.locator(FOLLOW_LABEL).first();
  if (await isVisible(label)) await label.click({ timeout: 2000 }).catch(() => {});
  if (await box.isChecked().catch(() => false)) await box.dispatchEvent('click').catch(() => {});
}

export const linkedin: SiteAdapter = {
  id: 'linkedin',

  async isLoggedIn(page) {
    await page.goto(FEED_URL, { waitUntil: 'domcontentloaded' });
    await pause(2000, 3000);
    // Logged out bounces to /login, /authwall, /checkpoint or the guest homepage; only /feed means logged in.
    return LOGGED_IN_PATH.test(new URL(page.url()).pathname);
  },

  async collectJobs(page, cfg) {
    const max = cfg.limits.maxJobsToScanPerSite;
    const refs = new Map<string, JobRef>();
    outer: for (const base of cfg.sites.linkedin.discoveryUrls) {
      for (const start of PAGE_STARTS) {
        const url = new URL(base);
        url.searchParams.set('start', String(start));
        await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
        await pause(4000, 6000);
        for (const id of jobIdsIn(await page.content())) {
          if (!refs.has(id)) refs.set(id, { site: 'linkedin', jobId: id, url: jobViewUrl(id) });
        }
        if (refs.size >= max) break outer;
      }
    }
    return [...refs.values()].slice(0, max);
  },

  async getDetails(page, ref): Promise<JobDetails> {
    await page.goto(ref.url, { waitUntil: 'domcontentloaded' });
    const primary = page.getByRole(PRIMARY.role, { name: PRIMARY.name });
    await primary.waitFor({ timeout: 15_000 }).catch(() => {});
    await pause();

    const { title, company } = parsePageTitle(await page.title());
    const topLine = await primary.locator('p').filter({ hasText: TOP_CARD_LINE }).first().innerText({ timeout: 3000 }).catch(() => '');
    const top = parseTopCard(topLine, company);
    const pills = (await primary.getByRole('link').allInnerTexts().catch(() => [] as string[])).map(clean).filter((p) => PILL_LINK.test(p));
    const workplace = workplaceType(pills);
    const location = workplace && !top.location.toLowerCase().includes(workplace.toLowerCase())
      ? clean(`${top.location} (${workplace})`)
      : top.location;
    const description = descriptionFrom(await primary.innerText({ timeout: 5000 }).catch(() => ''));

    let applyType: JobDetails['applyType'] = 'unknown';
    if (await isVisible(page.getByRole('heading', { name: APPLICATION_STATUS_HEADING }))) applyType = 'already_applied';
    else if (await isVisible(page.getByText(ALREADY_APPLIED_TEXT))) applyType = 'already_applied';
    else if (await isVisible(easyApplyButton(page))) applyType = 'in_site';
    else if (await isVisible(companyApplyButton(page))) applyType = 'company_site';

    return {
      ...ref, title, company, location, postedAt: top.postedAt, applicants: top.applicants,
      salary: salaryPill(pills), description, applyType,
    };
  },

  async apply(page, _job, ctx): Promise<ApplyOutcome> {
    const button = easyApplyButton(page);
    if (!(await isVisible(button))) return { status: 'failed', reason: 'SELECTOR_MISSING', detail: 'no Easy Apply button' };
    // the new layout attaches click handlers late: a click before the page settles does nothing, so retry once
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    const dlg = easyApplyModal(page);
    let opened = false;
    for (let attempt = 0; attempt < 2 && !opened; attempt++) {
      if (attempt) await pause(2000, 4000);
      await button.click();
      opened = await dlg.waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false);
    }
    if (!opened) return { status: 'failed', reason: 'SELECTOR_MISSING', detail: 'Easy Apply modal did not open' };

    let rescued = false;
    for (let step = 0; step < MAX_STEPS; step++) {
      // the dialog shows its header first and loads the step's fields a moment later
      await dlg.getByRole('button', { name: STEP_BUTTON_NAME }).first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
      await pause();
      await unfollowCompany(dlg);

      const { missing } = await fillFields(page, dlg, ctx.answers);
      if (missing.length) {
        await abandonEasyApply(page);
        return { status: 'needs_review', reason: 'UNANSWERED_QUESTIONS', detail: missing.map((q: Question) => q.label).join('\n') };
      }

      const submit = dlg.getByRole('button', { name: SUBMIT_NAME }).first();
      if (await isVisible(submit)) {
        if (ctx.dryRun) {
          await abandonEasyApply(page);
          return { status: 'applied', detail: 'dry-run' };
        }
        await submit.click();
        const sent = await page.getByText(SUBMITTED_TEXT).filter({ visible: true }).first()
          .waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false);
        await pause();
        const close = page.getByRole('dialog').getByRole('button', { name: DISMISS_NAME })
          .or(page.getByRole('dialog').getByRole('button', { name: DONE_NAME })).first();
        await close.click({ timeout: 3000 }).catch(() => {});
        return sent
          ? { status: 'applied' }
          : { status: 'failed', reason: 'NO_CONFIRMATION', detail: 'no confirmation after Submit application' };
      }

      const next = dlg.getByRole('button', { name: NEXT_NAME }).first();
      if (!(await isVisible(next))) {
        return { status: 'failed', reason: 'SELECTOR_MISSING', detail: 'no Next or Submit button in Easy Apply' };
      }
      await next.click();
      await pause();

      // an empty role="alert" live region is always there; only alerts with text are errors
      const error = dlg.locator(INLINE_ERROR).filter({ hasText: /\S/ }).or(dlg.getByText(ERROR_TEXT)).first();
      if (await isVisible(error)) {
        // "10 LPA" rejected by a numbers-only CTC field: retry with full rupees ("1000000")
        if (!rescued && (await fixLpaFields(dlg)) > 0) {
          rescued = true;
          continue;
        }
        // Some steps (e.g. Education) open their fields only after Next: rescan before calling it a rejection.
        const again = await fillFields(page, dlg, ctx.answers);
        if (again.missing.length) {
          await abandonEasyApply(page);
          return { status: 'needs_review', reason: 'UNANSWERED_QUESTIONS', detail: again.missing.map((q: Question) => q.label).join('\n') };
        }
        if (again.filled > 0 && !rescued) {
          rescued = true;
          continue; // the loop clicks Next again
        }
        const text = clean(await error.innerText().catch(() => '')).slice(0, 160);
        return { status: 'failed', reason: 'FORM_REJECTED', detail: text || 'inline validation error' };
      }
    }
    return { status: 'failed', reason: 'UNKNOWN', detail: `Easy Apply had more than ${MAX_STEPS} steps` };
  },

  async captureExternalUrl(page, _job, dryRun) {
    // the link already carries the company URL (safety/go/?url=...), so nothing needs clicking
    const href = await companyApplyButton(page).getAttribute('href', { timeout: 3000 }).catch(() => null);
    return externalApplyUrl(href) ?? (dryRun ? undefined : readCompanySiteUrl(page, companyApplyButton(page)));
  },

  abandon: abandonEasyApply,
};
