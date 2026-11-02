import type { Locator, Page } from 'playwright-core';
import type { SiteAdapter, JobRef, JobDetails, ApplyOutcome } from './types.js';
import type { Answerer, Question } from '../answers.js';
import { clean, isVisible, log, pause, sleep, textOf } from '../utils.js';

// Naukri applies with the resume on your Naukri profile; it has no per-job resume picker.
// Selectors verified read-only against the live site on 2026-11-02 (see Site notes in CLAUDE.md), except the
// questionnaire drawer and the success message, which only appear after a real Apply click.
const HOME_URL = 'https://www.naukri.com/mnjuser/homepage';
const LOGGED_IN_PATH = /^\/mnjuser\//;
const JOB_LINK = 'a[href*="/job-listings-"]';
/** The recommended feed splits jobs over tabs ("Applies", "Handpicked for you", "Profile", ...). */
const FEED_TABS = '[role="tab"]';
const RECOMMENDED_PATH = /\/mnjuser\/recommendedjobs/;

const TITLE = ['[class*="jd-header-title"]', 'h1'];
const COMPANY = ['[class*="jd-header-comp-name"] a', '[class*="jd-header-comp-name"]'];
const LOCATION = ['[class*="jhc__location"]'];
const EXPERIENCE = ['[class*="jhc__exp"]'];
const SALARY = ['[class*="jhc__salary"]'];
/** "Posted: 3 days ago", "Openings: 2", "Applicants: 100+". */
const STATS = '[class*="jhc__stat"]';
const DESCRIPTION = ['[class*="dang-inner-html"]', '[class*="job-desc"]'];

const APPLY_BUTTON_ID = '#apply-button';
/** The feed's bulk "Apply" (applies to every selected card). Never click it. */
const BULK_APPLY = '[class*="multi-apply"]';
const APPLY_BUTTON_NAME = /^(apply|i am interested)$/i;
const COMPANY_SITE_BUTTON_ID = '#company-site-button';
const COMPANY_SITE_BUTTON_NAME = /apply on company site/i;
/** Already applied: a plain label, not a button. */
const ALREADY_APPLIED = '#already-applied';
const SUCCESS_TEXT = /successfully applied|applied successfully|application (has been )?(sent|submitted)/i;
/** After Apply, Naukri usually navigates to an "Apply Confirmation" page with "Applied to <title>" (verified 2026-11-02). */
const CONFIRMATION_PAGE = '[class*="applied-job-content"]';
const CONFIRMATION_TITLE = /apply confirmation/i;

const CHAT_DRAWER = '[class*="chatbot_Drawer"]';
const CHAT_BOT_MSG = '[class*="botMsg"]';
const CHAT_RADIOS = '[class*="radio-btn-container"]';
const CHAT_CHIPS = '[class*="chatbot_Chip"], [class*="chipItem"]';
const CHAT_TEXT_BOX = '[contenteditable="true"], textarea';
const CHAT_SAVE = '[class*="sendMsg"]';
const CHAT_SAVE_TEXT = /^save$/i;
const CHAT_CLOSE = '[class*="crossIcon"], [class*="chatBot-close"], [aria-label*="close" i]';

const MAX_CHAT_TURNS = 15;

const applyButton = (page: Page) =>
  page.locator(APPLY_BUTTON_ID)
    .or(page.locator(`button:not(${BULK_APPLY})`).filter({ hasText: APPLY_BUTTON_NAME }))
    .first();
const companySiteButton = (page: Page) =>
  page.locator(COMPANY_SITE_BUTTON_ID).or(page.getByRole('button', { name: COMPANY_SITE_BUTTON_NAME })).first();
const alreadyApplied = (page: Page) => page.locator(ALREADY_APPLIED);

const appliedConfirmed = async (page: Page) =>
  CONFIRMATION_TITLE.test(await page.title().catch(() => '')) ||
  (await isVisible(page.locator(CONFIRMATION_PAGE))) ||
  (await isVisible(page.getByText(SUCCESS_TEXT))) ||
  (await isVisible(alreadyApplied(page)));

/** Trailing digits of a /job-listings-... URL, or null. Query string and hash are ignored. */
export function naukriJobId(href: string): string | null {
  const url = href.split(/[?#]/)[0].replace(/\/+$/, '');
  if (!url.includes('/job-listings-')) return null;
  return url.match(/-(\d{6,})$/)?.[1] ?? null;
}

/** "Acme Corp\n3.9\n120 Reviews" or "Acme Corp 3.9 (120 Reviews)" -> "Acme Corp". */
export function stripRating(text: string): string {
  const first = (text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return clean(first.replace(/\s+\d(\.\d)?\s*(\(?\s*[\d,.]+k?\s*reviews?\s*\)?)?\s*$/i, ''));
}

/** "5 - 8 years Not Disclosed" (the experience box also holds the salary) -> "5 - 8 years". */
export function cleanExperience(text: string): string | undefined {
  const t = clean(text);
  return t.match(/^.*?\b(?:years?|yrs?)\b/i)?.[0] ?? (t || undefined);
}

/** Naukri's header stats ("Posted: 3 days ago", "Applicants: 100+") -> postedAt / applicants. */
export function parseNaukriStats(stats: string[]): { postedAt?: string; applicants?: string } {
  const out: { postedAt?: string; applicants?: string } = {};
  for (const raw of stats) {
    const s = clean(raw);
    const m = s.match(/^(posted|applicants)\s*:?\s*(.+)$/i);
    if (!m) continue;
    if (/^posted/i.test(m[1])) out.postedAt ??= m[2];
    else out.applicants ??= m[2];
  }
  return out;
}

/**
 * Clicks a button that opens the company's apply page and reads where it lands, without touching that page.
 * A new tab is read and closed; a same-tab navigation is read and then undone with goBack().
 */
export async function readCompanySiteUrl(page: Page, button: Locator): Promise<string | undefined> {
  if (!(await isVisible(button))) return undefined;
  const startUrl = page.url();
  const popupWait = page.waitForEvent('popup', { timeout: 10_000 }).catch(() => null);
  const sameTabWait = page
    .waitForURL((u) => u.href !== startUrl, { timeout: 10_000, waitUntil: 'commit' })
    .then(() => null)
    .catch(() => null);
  try {
    await button.first().click({ timeout: 5000 });
  } catch {
    return undefined;
  }
  const host = (u: string) => {
    try {
      return new URL(u).host;
    } catch {
      return '';
    }
  };
  const usable = (u: string) => (/^https?:\/\//.test(u) && host(u) !== host(startUrl) ? u : undefined);
  let popup = await Promise.race([popupWait, sameTabWait]);
  // A same-site URL change (history push) is not the company page; keep waiting for a tab.
  if (!popup && host(page.url()) === host(startUrl)) popup = await popupWait;

  if (popup) {
    try {
      await popup.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
      await popup.waitForURL((u) => u.protocol.startsWith('http'), { timeout: 5000 }).catch(() => {});
      await sleep(1500); // let client-side redirects settle before reading the URL
      return usable(popup.url());
    } finally {
      await popup.close().catch(() => {});
    }
  }
  if (page.url() !== startUrl) {
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
    await sleep(1500); // let redirects settle before reading the URL
    const url = usable(page.url());
    await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    return url;
  }
  // Neither a new tab nor a navigation (e.g. an interstitial dialog): leave it alone.
  await page.keyboard.press('Escape').catch(() => {});
  return undefined;
}

async function closeDrawer(page: Page) {
  const drawer = page.locator(CHAT_DRAWER).first();
  if (!(await isVisible(drawer))) return;
  const close = drawer.locator(CHAT_CLOSE).first();
  if (await isVisible(close)) await close.click().catch(() => {});
  else await page.keyboard.press('Escape').catch(() => {});
  await pause(500, 1000);
}

/** Text of the last bot message, polling while it is still an empty "typing" bubble. */
async function waitForText(botMsgs: Locator, timeoutMs = 10_000): Promise<string> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const text = clean(await botMsgs.last().innerText({ timeout: 2000 }).catch(() => ''));
    if (text) return text;
    await sleep(400);
  }
  return '';
}

/** Waits until the bot posts a new message (more than `before`) or the drawer closes. */
async function waitForBotReply(drawer: Locator, before: number, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!(await isVisible(drawer))) return;
    if ((await drawer.locator(CHAT_BOT_MSG).count().catch(() => 0)) > before) return;
    await sleep(400);
  }
}

/**
 * Naukri's recruiter questionnaire is a chat drawer: one question at a time, chips/radios or a text box, then Save.
 * Returns an outcome when it has to stop early, or null when the drawer finished.
 */
async function answerChatbot(page: Page, drawer: Locator, answers: Answerer): Promise<ApplyOutcome | null> {
  let lastQuestion = '';
  for (let turn = 0; turn < MAX_CHAT_TURNS; turn++) {
    await pause();
    if (!(await isVisible(drawer))) return null;

    const botMsgs = drawer.locator(CHAT_BOT_MSG);
    const msgCount = await botMsgs.count().catch(() => 0);
    const input = drawer.locator(`${CHAT_RADIOS}, ${CHAT_CHIPS}, ${CHAT_TEXT_BOX}`);
    // the bot shows an empty "typing" bubble first: wait for its text instead of taking it as the end
    const question = await waitForText(botMsgs);
    if (!question) {
      if (!(await isVisible(input))) return null;
      return { status: 'failed', reason: 'SELECTOR_MISSING', detail: 'could not read the questionnaire question' };
    }
    if (question === lastQuestion) {
      return { status: 'failed', reason: 'FORM_REJECTED', detail: `Naukri did not accept the answer to: ${question}` };
    }
    lastQuestion = question;

    const radios = drawer.locator(CHAT_RADIOS);
    const chips = drawer.locator(CHAT_CHIPS);
    const textBox = drawer.locator(CHAT_TEXT_BOX).first();
    const choices = (await radios.count()) ? radios : (await chips.count()) ? chips : null;
    const unanswered = async (): Promise<ApplyOutcome> => {
      await closeDrawer(page);
      return { status: 'needs_review', reason: 'UNANSWERED_QUESTIONS', detail: question };
    };

    if (choices) {
      const options = (await choices.allInnerTexts()).map(clean);
      const q: Question = { label: question, kind: 'radio', options };
      const ans = await answers.answer(q);
      if (!ans) return unanswered();
      let idx = options.indexOf(ans);
      if (idx < 0) idx = options.findIndex((o) => o.toLowerCase() === ans.toLowerCase());
      // nth(-1) would pick the last chip, so an unmatched answer is treated as unanswered.
      if (idx < 0) return unanswered();
      // radio rows (".ssrc__radio-btn-container") only select when their label or input is clicked
      const choice = choices.nth(idx);
      const label = choice.locator('label, input[type="radio"]').first();
      if (await label.count()) await label.click();
      else await choice.click();
      const radio = choice.locator('input[type="radio"]').first();
      // never force-click: it lands on whatever is drawn there; send the click event to the input instead
      if ((await radio.count()) && !(await radio.isChecked().catch(() => false))) await radio.dispatchEvent('click').catch(() => {});
      if ((await radio.count()) && !(await radio.isChecked().catch(() => false))) {
        return { status: 'failed', reason: 'FORM_REJECTED', detail: `could not select "${ans}" for: ${question}` };
      }
    } else if (await isVisible(textBox)) {
      const q: Question = { label: question, kind: 'text' };
      const ans = await answers.answer(q);
      if (!ans) return unanswered();
      await textBox.click();
      await page.keyboard.type(ans, { delay: 40 });
    } else {
      return null; // closing message, nothing to answer
    }

    await pause();
    const save = drawer.locator(CHAT_SAVE).or(drawer.getByText(CHAT_SAVE_TEXT)).first();
    if (await isVisible(save)) await save.click();
    await waitForBotReply(drawer, msgCount);
  }
  return { status: 'failed', reason: 'UNKNOWN', detail: `questionnaire still open after ${MAX_CHAT_TURNS} questions` };
}

/** Polls for a success signal or the questionnaire drawer after clicking Apply. */
async function waitAfterApply(page: Page, timeoutMs = 12_000, watchDrawer = true): Promise<'applied' | 'drawer' | 'none'> {
  const drawer = page.locator(CHAT_DRAWER).first();
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await appliedConfirmed(page)) return 'applied';
    if (watchDrawer && (await isVisible(drawer))) return 'drawer';
    await sleep(500);
  }
  return 'none';
}

export const naukri: SiteAdapter = {
  id: 'naukri',

  async isLoggedIn(page) {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });
    await pause(2000, 3000);
    // Logged out redirects to /nlogin/... or the public homepage; only a /mnjuser/ page means logged in.
    return LOGGED_IN_PATH.test(new URL(page.url()).pathname);
  },

  async collectJobs(page, cfg) {
    const max = cfg.limits.maxJobsToScanPerSite;
    const refs = new Map<string, JobRef>();
    for (const url of cfg.sites.naukri.discoveryUrls) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.locator(JOB_LINK).first().waitFor({ timeout: 15_000 }).catch(() => {});
      await pause(1500, 3000);
      const collect = async () => {
        for (let i = 0; i < 4; i++) {
          await page.mouse.wheel(0, 2500);
          await pause(800, 1500);
        }
        // DOM boundary: anchors from the results page.
        const hrefs = await page.$$eval(JOB_LINK, (as) => as.map((a) => (a as HTMLAnchorElement).href));
        for (const href of hrefs) {
          const jobId = naukriJobId(href);
          if (!jobId || refs.has(jobId)) continue;
          refs.set(jobId, { site: 'naukri', jobId, url: href.split(/[?#]/)[0] });
        }
        return hrefs.length;
      };
      let found = await collect();
      // recommended feed: every tab holds a different set of jobs (clicking a tab only switches the list)
      if (RECOMMENDED_PATH.test(url)) {
        const tabs = page.locator(FEED_TABS);
        const n = await tabs.count();
        for (let i = 1; i < n && refs.size < max; i++) {
          await page.mouse.wheel(0, -100_000);
          await tabs.nth(i).click().catch(() => {});
          await pause(1500, 3000);
          found += await collect();
        }
      }
      if (!found) log(`naukri: no job links found on ${url} (layout may have changed)`);
      if (refs.size >= max) break;
    }
    return [...refs.values()].slice(0, max);
  },

  async getDetails(page, ref): Promise<JobDetails> {
    await page.goto(ref.url, { waitUntil: 'domcontentloaded' });
    await page.locator(TITLE.join(', ')).first().waitFor({ timeout: 15_000 }).catch(() => {});
    await pause();

    const title = clean(await textOf(page, TITLE));
    const company = stripRating(await textOf(page, COMPANY));
    const location = clean(await textOf(page, LOCATION));
    const experience = cleanExperience(await textOf(page, EXPERIENCE));
    const salary = clean(await textOf(page, SALARY)) || undefined;
    const stats = parseNaukriStats(await page.locator(STATS).allInnerTexts().catch(() => []));
    const description = await textOf(page, DESCRIPTION, 4000);

    let applyType: JobDetails['applyType'] = 'unknown';
    if (await isVisible(alreadyApplied(page))) applyType = 'already_applied';
    else if (await isVisible(companySiteButton(page))) applyType = 'company_site';
    else if (await isVisible(applyButton(page))) applyType = 'in_site';

    return { ...ref, title, company, location, experience, salary, ...stats, description, applyType };
  },

  async apply(page, _job, ctx) {
    // Naukri submits on the first Apply click, so a dry run must not click anything at all.
    if (ctx.dryRun) return { status: 'applied', detail: 'dry-run: stopped before Apply (Naukri submits on click)' };

    const btn = applyButton(page);
    if (!(await isVisible(btn))) return { status: 'failed', reason: 'SELECTOR_MISSING', detail: 'no Apply button found' };
    await btn.click();

    const first = await waitAfterApply(page);
    if (first === 'applied') return { status: 'applied' };
    if (first === 'none') return { status: 'failed', reason: 'NO_CONFIRMATION', detail: 'no confirmation after clicking Apply' };

    const stop = await answerChatbot(page, page.locator(CHAT_DRAWER).first(), ctx.answers);
    if (stop) return stop;
    if ((await waitAfterApply(page, 10_000, false)) === 'applied') return { status: 'applied' };
    return { status: 'failed', reason: 'NO_CONFIRMATION', detail: 'questionnaire done but no confirmation shown' };
  },

  async captureExternalUrl(page, _job, dryRun) {
    // Naukri only reveals the company URL after a click, which dry runs never make
    return dryRun ? undefined : readCompanySiteUrl(page, companySiteButton(page));
  },

  async abandon(page) {
    await closeDrawer(page);
    await page.keyboard.press('Escape').catch(() => {});
  },
};
