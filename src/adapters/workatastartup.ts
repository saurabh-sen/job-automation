import type { Page } from 'playwright-core';
import type { SiteAdapter, JobRef, JobDetails, ApplyOutcome } from './types.js';
import { fillTemplate, TEMPLATE_LIMITS } from '../templates.js';
import { clean, isVisible, log, pause, sleep } from '../utils.js';

// Verified on 2026-11-02 (see Site notes in CLAUDE.md): directory, job page and the Apply dialog (opened and closed).
// Not seen yet: the page after "Send". YC jobs board URLs (ycombinator.com/companies/.../jobs/...) are not collected yet.
const BASE = 'https://www.workatastartup.com';
const LOGGED_IN_NAV = /^(inbox|my profile)$/i;
const JOB_HREF = /href="(?:https:\/\/www\.workatastartup\.com)?\/jobs\/(\d+)[^"]*"/g;
const SCROLLS = 6;

/** Page title: "<role> at <company> | Y Combinator's Work at a Startup". */
const TITLE_PATTERN = /^(.*) at (.*?) \| Y Combinator/;
/** "Apply" is an <a> without href (no link role), so it is found by its text. */
const APPLY_TEXT = /^\s*Apply\s*$/;
const APPLIED_TEXT = /^\s*Applied\s*$/;
/** The dialog: "Reach out to <name> at <company>", a "Your message" box, "Send" (disabled until filled) and "Close". */
const DIALOG_NAME = /^reach out to\b/i;
const MESSAGE_NAME = /your message/i;
const SEND_NAME = /^send$/i;
const CLOSE_NAME = /^close$/i;
const SEND_TIMEOUT_MS = 90_000;
const LIMIT_ALERT = /limit of \d+ applications/i;

const applyLink = (page: Page) => page.locator('a, button').filter({ hasText: APPLY_TEXT }).filter({ visible: true }).first();
const dialog = (page: Page) => page.getByRole('dialog', { name: DIALOG_NAME }).first();

/** "Senior Software Engineer at FleetWorks | Y Combinator's Work at a Startup" -> parts. */
export function parseWaasTitle(t: string): { title: string; company: string } {
  const m = clean(t).match(TITLE_PATTERN);
  return m ? { title: m[1], company: m[2] } : { title: '', company: '' };
}

/** Unique Work at a Startup job ids in a page's HTML, in order. */
export function waasJobIds(html: string): string[] {
  return [...new Set([...html.matchAll(JOB_HREF)].map((m) => m[1]))];
}

/** Value of a "Location" / "Experience" / ... term in the job's fact list. */
function fact(body: string, term: string): string | undefined {
  return body.match(new RegExp(`(?:^|\\n)${term}\\s*\\n\\s*([^\\n]+)`, 'i'))?.[1]?.trim();
}

export const workatastartup: SiteAdapter = {
  id: 'workatastartup',

  async isLoggedIn(page) {
    await page.goto(`${BASE}/companies`, { waitUntil: 'domcontentloaded' });
    await pause(2500, 4000);
    // a "Sign in" link is shown even when logged in, so only the logged-in nav counts
    return isVisible(page.getByRole('link', { name: LOGGED_IN_NAV }));
  },

  async collectJobs(page, cfg) {
    const max = cfg.limits.maxJobsToScanPerSite;
    const refs = new Map<string, JobRef>();
    for (const url of cfg.sites.workatastartup.discoveryUrls) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await pause(4000, 6000);
      for (let i = 0; i <= SCROLLS && refs.size < max; i++) {
        for (const id of waasJobIds(await page.content())) {
          if (!refs.has(id)) refs.set(id, { site: 'workatastartup', jobId: id, url: `${BASE}/jobs/${id}` });
        }
        await page.mouse.wheel(0, 4000);
        await pause(2000, 3000);
      }
      if (!refs.size) log(`workatastartup: no job links found on ${url} (set your filters in the site and paste that URL)`);
      if (refs.size >= max) break;
    }
    return [...refs.values()].slice(0, max);
  },

  async getDetails(page, ref): Promise<JobDetails> {
    await page.goto(ref.url, { waitUntil: 'domcontentloaded' });
    await page.locator('h1').first().waitFor({ timeout: 15_000 }).catch(() => {});
    await pause();

    const { title, company } = parseWaasTitle(await page.title());
    const body = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    const visa = fact(body, 'Visa sponsorship');
    const start = body.search(/About the role/i);
    const description = [visa ? `Visa sponsorship: ${visa}` : '', start >= 0 ? body.slice(start) : body].join('\n').trim().slice(0, 20000);

    let applyType: JobDetails['applyType'] = 'unknown';
    if (await isVisible(page.locator('a, button').filter({ hasText: APPLIED_TEXT }))) applyType = 'already_applied';
    else if (await isVisible(applyLink(page))) applyType = 'in_site';

    return {
      ...ref, title, company, location: fact(body, 'Location') ?? '', experience: fact(body, 'Experience'),
      salary: fact(body, 'Salary'), description, applyType,
    };
  },

  async apply(page, job, ctx): Promise<ApplyOutcome> {
    const link = applyLink(page);
    if (!(await isVisible(link))) return { status: 'failed', reason: 'SELECTOR_MISSING', detail: 'no Apply link' };
    await link.click();
    // the <dialog> element itself has no size (its contents do), so wait for the message box rather than the dialog
    const dlg = dialog(page);
    const box = dlg.getByRole('textbox', { name: MESSAGE_NAME }).or(dlg.locator('textarea')).first();
    if (!(await box.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false))) {
      return { status: 'failed', reason: 'SELECTOR_MISSING', detail: 'Apply dialog did not open' };
    }
    await pause();
    const message = fillTemplate(ctx.cfg.templates.workatastartup, { firstName: ctx.cfg.profile.firstName, company: job.company, role: job.title },
      TEMPLATE_LIMITS.workatastartup);
    await box.fill(message);
    await pause();

    const send = dlg.getByRole('button', { name: SEND_NAME }).first();
    if (!(await send.isEnabled().catch(() => false))) {
      await workatastartup.abandon(page);
      return { status: 'failed', reason: 'FORM_REJECTED', detail: 'Send stayed disabled after writing the message' };
    }
    if (ctx.dryRun) {
      await workatastartup.abandon(page);
      return { status: 'applied', detail: 'dry-run' };
    }
    // the site answers some sends with a browser alert ("You've reached your limit of 5 applications per week.")
    let alertText = '';
    page.once('dialog', (d) => {
      alertText = d.message();
      void d.dismiss().catch(() => {});
    });
    await send.click();
    // Sending can take a while (Close and Send stay disabled meanwhile). Leaving the page too early cancels it,
    // so wait until the dialog closes, or Send becomes clickable again (the send failed).
    const end = Date.now() + SEND_TIMEOUT_MS;
    let closed = false;
    while (Date.now() < end) {
      if (LIMIT_ALERT.test(alertText)) {
        await workatastartup.abandon(page);
        return { status: 'failed', reason: 'SITE_LIMIT', detail: clean(alertText) };
      }
      if (!(await isVisible(box))) { closed = true; break; }
      if (await send.isEnabled().catch(() => false)) break;
      await sleep(1000);
    }
    await pause();
    if (LIMIT_ALERT.test(alertText)) {
      await workatastartup.abandon(page);
      return { status: 'failed', reason: 'SITE_LIMIT', detail: clean(alertText) };
    }
    if (!closed) {
      return { status: 'failed', reason: 'NO_CONFIRMATION', detail: 'the message did not finish sending; check the Inbox before re-applying' };
    }
    // a fresh load shows whether the site recorded it
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await pause(2000, 3000);
    const applied = await isVisible(page.locator('a, button').filter({ hasText: APPLIED_TEXT })) || !(await isVisible(applyLink(page)));
    if (applied) return { status: 'applied' };
    return { status: 'failed', reason: 'NO_CONFIRMATION', detail: 'the dialog closed but the job still shows Apply; check the Inbox before re-applying' };
  },

  async abandon(page) {
    const dlg = dialog(page);
    if (!(await isVisible(dlg.getByRole('button', { name: CLOSE_NAME })))) return;
    const close = dlg.getByRole('button', { name: CLOSE_NAME }).first();
    if (await isVisible(close)) await close.click().catch(() => {});
    else await page.keyboard.press('Escape').catch(() => {});
    await pause(500, 1000);
  },
};
