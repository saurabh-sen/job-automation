import type { Browser, Page } from 'playwright-core';
import { ConfigError, loadConfig, SITE_IDS, SITE_NAMES, type Config, type SiteId } from './config.js';
import { JobDb, type JobRow, type JobStatus } from './db.js';
import { Telegram, formatHandoff, formatSummary, sendStartupError, stripHtml } from './telegram.js';
import { checkFilters } from './filters.js';
import { Answerer } from './answers.js';
import { writeReport } from './report.js';
import { connectBrowser, openBackgroundPage } from './browser.js';
import { saveFailure } from './debug.js';
import { acquireLock, releaseLock } from './lock.js';
import { ADAPTERS } from './adapters/index.js';
import type { ApplyOutcome, JobDetails, JobRef, ReasonCode, SiteAdapter } from './adapters/types.js';
import { checkpointHit, enableFileLog, errMsg, jobLine, localDate, log, pause, rand, setActionDelay, sleep } from './utils.js';

export interface RunOptions {
  dryRun: boolean;
  site?: SiteId;
  limit?: number;
}

/** Parses `--dry-run`, `--site=<id>`, `--limit=<n>`. Throws an Error with a short, printable message on bad input. */
export function parseRunArgs(argv: string[]): RunOptions {
  const opts: RunOptions = { dryRun: false };
  for (const a of argv) {
    if (a === '--dry-run') opts.dryRun = true;
    else if (a.startsWith('--site=')) {
      const id = a.slice('--site='.length);
      if (!(SITE_IDS as readonly string[]).includes(id)) throw new Error(`Unknown site "${id}". Use one of: ${SITE_IDS.join(', ')}.`);
      opts.site = id as SiteId;
    } else if (a.startsWith('--limit=')) {
      const raw = a.slice('--limit='.length);
      const n = Number(raw);
      if (!/^\d+$/.test(raw) || n < 1) throw new Error(`--limit must be a whole number of 1 or more (got "${raw}").`);
      opts.limit = n;
    } else throw new Error(`Unknown option "${a}". Use --dry-run, --site=<id>, --limit=<n>.`);
  }
  return opts;
}

export type SummaryKind = 'none' | 'run' | 'day';

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** 'day' once per day from `dailySummaryAfter` on (real runs only); else 'run' if anything happened; else 'none'. */
export function summaryDecision(i: {
  activity: number; notes: number; now: Date; dailySummaryAfter: string; dailySentOn: string | null; dryRun: boolean;
}): SummaryKind {
  const nowMin = i.now.getHours() * 60 + i.now.getMinutes();
  if (!i.dryRun && nowMin >= minutesOf(i.dailySummaryAfter) && i.dailySentOn !== localDate(i.now)) return 'day';
  return i.activity > 0 || i.notes > 0 ? 'run' : 'none';
}

export interface RunStats {
  applied: Partial<Record<SiteId, number>>;
  /** company_site + needs_review + failed */
  sentToYou: number;
  skipped: number;
  failed: number;
}

export const emptyStats = (): RunStats => ({ applied: {}, sentToYou: 0, skipped: 0, failed: 0 });

/** Adds one recorded job to the stats. already_applied counts nowhere. */
export function countJob(s: RunStats, site: SiteId, status: JobStatus): void {
  if (status === 'applied') s.applied[site] = (s.applied[site] ?? 0) + 1;
  else if (status === 'skipped') s.skipped++;
  else if (status === 'company_site' || status === 'needs_review' || status === 'failed') {
    s.sentToYou++;
    if (status === 'failed') s.failed++;
  }
}

/** In a real run, a forced-dry (not live) site records nothing, so it must not show up in the summary either. */
export const countsInSummary = (siteDry: boolean, runDry: boolean) => !siteDry || runDry;

/** Whole-day stats from the jobs table. */
export function statsFromRows(rows: Pick<JobRow, 'site' | 'status'>[]): RunStats {
  const s = emptyStats();
  for (const r of rows) countJob(s, r.site, r.status);
  return s;
}

/** Jobs applied to or handed off (failed is part of sentToYou). Skips don't count. */
export const activityOf = (s: RunStats) => Object.values(s.applied).reduce((n, v) => n + (v ?? 0), 0) + s.sentToYou;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n: number) => String(n).padStart(2, '0');

/** "Job agent · 1 Nov, 11:30" / "Job agent · 1 Nov (day summary)", prefixed "(dry run) " for dry runs. */
export function summaryHeader(kind: 'run' | 'day', now: Date, dryRun: boolean): string {
  const day = `${now.getDate()} ${MONTHS[now.getMonth()]}`;
  const when = kind === 'day' ? `${day} (day summary)` : `${day}, ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  return `${dryRun ? '(dry run) ' : ''}Job agent · ${when}`;
}

/** Console label for a recorded job. */
export function statusLabel(status: JobStatus, dryRun: boolean): string {
  switch (status) {
    case 'applied': return dryRun ? 'WOULD APPLY' : 'APPLIED';
    case 'company_site': return 'COMPANY SITE';
    case 'needs_review': return 'NEEDS REVIEW';
    case 'already_applied': return 'ALREADY APPLIED';
    case 'skipped': return 'SKIPPED';
    default: return 'FAILED';
  }
}

const loggedOutNote = (id: SiteId) =>
  `${SITE_NAMES[id]}: logged out. Open the agent Chrome (npm run chrome) and log in again; the next run continues.`;
const checkpointNote = (id: SiteId) =>
  `${SITE_NAMES[id]}: stopped at a captcha or verification screen. Clear it in the agent Chrome; the next run continues.`;

/** After a site's own application limit (e.g. Work at a Startup's 5 per week), skip it for this long. */
const SITE_LIMIT_PAUSE_H = 24;

/** Why a site loop ended early. 'all' stops the whole run (--limit reached). */
type SiteEnd = 'done' | 'all';

interface RunState {
  cfg: Config;
  db: JobDb;
  opts: RunOptions;
  stats: RunStats;
  notes: string[];
  attempts: number;
}

function addNote(st: RunState, text: string) {
  st.notes.push(text);
  log(text);
  if (!st.opts.dryRun) st.db.addNote(text);
}

async function runSite(st: RunState, id: SiteId, adapter: SiteAdapter, page: Page, siteDry: boolean): Promise<SiteEnd> {
  const { cfg, db, opts } = st;
  const name = SITE_NAMES[id];
  const cap = cfg.limits.dailyCap[id];
  let applied = db.appliedToday(id);
  if (applied >= cap) {
    log(`${name}: daily cap of ${cap} already reached`);
    return 'done';
  }
  const limitedAt = db.getMeta(`site_limit:${id}`);
  if (limitedAt && Date.now() - Date.parse(limitedAt) < SITE_LIMIT_PAUSE_H * 3600_000) {
    log(`${name}: paused after hitting the site's application limit (${limitedAt}); skipping`);
    return 'done';
  }

  /** The one place jobs are recorded: prints the line, counts it, writes it unless this site is a dry run. */
  const record = (job: JobRef & Partial<JobDetails>, status: JobStatus, o: { reason?: string; detail?: string; externalUrl?: string; label?: string } = {}) => {
    const shown = status === 'applied' ? '' : status === 'company_site' ? o.externalUrl ?? 'no link captured' : o.detail || o.reason;
    const extra = (shown ?? '').replace(/\s*\n\s*/g, '; ');
    log(jobLine(`${o.label ?? statusLabel(status, siteDry)} `, job, extra));
    if (countsInSummary(siteDry, opts.dryRun)) countJob(st.stats, id, status);
    if (siteDry) return;
    db.recordJob({
      site: job.site, jobId: job.jobId, url: job.url, externalUrl: o.externalUrl, title: job.title, company: job.company,
      location: job.location || undefined, experience: job.experience, salary: job.salary, postedAt: job.postedAt,
      applicants: job.applicants, status, reason: o.reason, detail: o.detail,
    });
  };
  const failSnapshot = (job: JobRef) => saveFailure(page, id, job.jobId);

  const loggedIn = await adapter.isLoggedIn(page);
  if (await checkpointHit(page)) {
    addNote(st, checkpointNote(id));
    return 'done';
  }
  if (!loggedIn) {
    addNote(st, loggedOutNote(id));
    return 'done';
  }
  const refs = await adapter.collectJobs(page, cfg);
  if (await checkpointHit(page)) {
    addNote(st, checkpointNote(id));
    return 'done';
  }
  log(`${name}: ${refs.length} jobs found`);

  for (const ref of refs) {
    if (!db.shouldProcess(ref.site, ref.jobId)) continue;
    if (opts.limit != null && st.attempts >= opts.limit) {
      log(`Stopping: --limit=${opts.limit} apply attempts reached`);
      return 'all';
    }
    if (await checkpointHit(page)) {
      addNote(st, checkpointNote(id));
      return 'done';
    }

    let job: JobDetails;
    try {
      job = await adapter.getDetails(page, ref);
    } catch (e) {
      if (await checkpointHit(page)) {
        addNote(st, checkpointNote(id));
        return 'done';
      }
      const reason: ReasonCode = e instanceof Error && e.name === 'TimeoutError' ? 'TIMEOUT' : 'SELECTOR_MISSING';
      await failSnapshot(ref);
      record(ref, 'failed', { reason, detail: `reading the job: ${errMsg(e)}` });
      continue;
    }
    if (await checkpointHit(page)) {
      addNote(st, checkpointNote(id));
      return 'done';
    }

    if (!job.title) {
      await failSnapshot(ref);
      record(job, 'failed', { reason: 'SELECTOR_MISSING', detail: 'could not read the job title' });
      continue;
    }
    if (job.applyType === 'already_applied') {
      record(job, 'already_applied');
      continue;
    }
    const verdict = checkFilters(job, cfg.filters);
    if (!verdict.ok) {
      record(job, 'skipped', { reason: verdict.reason });
      continue;
    }
    const dup = db.appliedElsewhere(job.company, job.title, id);
    if (dup) {
      record(job, 'skipped', { reason: `applied via ${SITE_NAMES[dup.site] ?? dup.site}`, label: 'DUPLICATE' });
      continue;
    }
    if (job.applyType === 'company_site') {
      // adapters never click in dry runs; live runs may open the company page only to read its link
      const externalUrl = adapter.captureExternalUrl
        ? await adapter.captureExternalUrl(page, job, siteDry).catch((e: unknown) => {
            log(`${name}: could not read the company link: ${errMsg(e)}`);
            return undefined;
          })
        : undefined;
      record(job, 'company_site', { reason: 'COMPANY_SITE', externalUrl });
      if (!siteDry) await pause(3000, 8000);
      continue;
    }
    if (job.applyType !== 'in_site') {
      await failSnapshot(job);
      record(job, 'failed', { reason: 'SELECTOR_MISSING', detail: 'no Apply button found' });
      continue;
    }

    st.attempts++;
    const answers = new Answerer(cfg, db, { url: job.url, title: job.title, location: job.location }, { dryRun: siteDry });
    let outcome: ApplyOutcome;
    try {
      outcome = await adapter.apply(page, job, { cfg, answers, dryRun: siteDry });
    } catch (e) {
      outcome = { status: 'failed', reason: 'UNKNOWN', detail: errMsg(e) };
    }

    if (outcome.reason === 'SITE_LIMIT') {
      // not this job's fault: leave it unrecorded so it's tried again once the site's limit resets
      st.attempts--;
      if (!opts.dryRun) db.setMeta(`site_limit:${id}`, new Date().toISOString());
      addNote(st, `${name}: ${outcome.detail ?? 'application limit reached'} Paused for ${SITE_LIMIT_PAUSE_H} hours, then the agent tries again.`);
      return 'done';
    }
    if (outcome.reason === 'CHECKPOINT' || (await checkpointHit(page))) {
      // never touch a checkpoint page (no abandon clicks); keep a real application, let the next run redo the rest
      if (outcome.status === 'applied') record(job, 'applied', { detail: outcome.detail });
      addNote(st, checkpointNote(id));
      return 'done';
    }

    if (outcome.status !== 'applied' && outcome.status !== 'company_site' && outcome.status !== 'already_applied') {
      await failSnapshot(job); // before abandon, so the half-filled form and its errors are captured
      await adapter.abandon(page).catch((e: unknown) => log(`${name}: could not close the form: ${errMsg(e)}`));
    }
    record(job, outcome.status, {
      reason: outcome.reason ?? (outcome.status === 'company_site' ? 'COMPANY_SITE' : undefined),
      detail: outcome.detail,
      externalUrl: outcome.externalUrl,
    });

    if (outcome.status === 'applied' && !siteDry && ++applied >= cap) {
      log(`${name}: daily cap of ${cap} reached`);
      return 'done';
    }
    if (opts.limit != null && st.attempts >= opts.limit) {
      log(`Stopping: --limit=${opts.limit} apply attempts reached`);
      return 'all';
    }
    await sleep(rand(cfg.limits.delayBetweenAppliesMs[0], cfg.limits.delayBetweenAppliesMs[1]));
  }
  return 'done';
}

/** Sends unsent hand-offs; a job is marked notified only after Telegram accepts it. */
async function sendHandoffs(db: JobDb, tg: Telegram) {
  const jobs = db.unnotifiedHandoffs();
  let sent = 0;
  for (const job of jobs) {
    if (await tg.send(formatHandoff(job))) {
      db.markNotified(job.site, job.job_id);
      sent++;
    } else {
      log(`Telegram: could not send a hand-off (${tg.lastError ?? 'unknown error'}); it goes out next run`);
      break;
    }
  }
  if (jobs.length) log(`Telegram: sent ${sent} of ${jobs.length} hand-offs`);
}

async function sendSummary(st: RunState, tg: Telegram, now: Date) {
  const { cfg, db, opts } = st;
  const kind = summaryDecision({
    activity: activityOf(st.stats), notes: st.notes.length, now,
    dailySummaryAfter: cfg.telegram.dailySummaryAfter, dailySentOn: db.getMeta('daily_summary_sent'), dryRun: opts.dryRun,
  });
  const stats = kind === 'day' ? statsFromRows(db.jobsOn(localDate(now))) : st.stats;
  const html = formatSummary({ header: summaryHeader(kind === 'day' ? 'day' : 'run', now, opts.dryRun), ...stats, notes: st.notes });
  log('');
  log(stripHtml(html));

  if (kind === 'none' || !tg.enabled) return;
  // dry runs only alert about logouts/captchas; real runs follow the summary rule
  if (opts.dryRun && st.notes.length === 0) return;
  const ok = await tg.send(html);
  if (!ok) log(`Telegram: summary not sent (${tg.lastError ?? 'unknown error'})`);
  if (ok && kind === 'day') db.setMeta('daily_summary_sent', localDate(now));
}

/** One full run: lock → sites → filters → apply → record → Telegram → report. Returns the process exit code. */
export async function runAll(opts: RunOptions): Promise<number> {
  enableFileLog();
  if (!acquireLock()) {
    log('Another run is in progress; exiting.');
    return 0;
  }
  let db: JobDb | undefined;
  let browser: Browser | undefined;
  const pages: Page[] = [];
  // Ctrl-C / kill: close our tabs, disconnect and release the lock so the next scheduled run isn't blocked
  const onSignal = (sig: NodeJS.Signals) => {
    log(`Stopped (${sig}).`);
    void Promise.allSettled(pages.map((p) => p.close()))
      .then(() => browser?.close().catch(() => {}))
      .finally(() => {
        try { db?.close(); } catch { /* already closed */ }
        releaseLock();
        process.exit(130);
      });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    let cfg: Config;
    try {
      cfg = loadConfig();
    } catch (e) {
      if (e instanceof ConfigError) {
        console.error(e.message);
        await sendStartupError(`config.yaml has ${e.problems.length} problem(s). Run \`npm run apply -- --dry-run\` to see them.`);
      } else {
        console.error(`Could not read config.yaml: ${errMsg(e)}`);
        await sendStartupError('config.yaml could not be read. Run `npm run apply -- --dry-run` to see why.');
      }
      return 1;
    }
    setActionDelay(cfg.limits.actionDelayMs);
    db = new JobDb();
    const tg = new Telegram(cfg.telegram);

    try {
      browser = await connectBrowser(cfg.chrome);
    } catch (e) {
      console.error(`Could not attach to Chrome: ${errMsg(e)}`);
      await sendStartupError(`Could not attach to Chrome: ${errMsg(e)}`);
      return 1;
    }
    const context = browser.contexts()[0];
    if (!context) {
      const m = 'Attached to Chrome but found no browser window. Run `npm run chrome` and try again.';
      console.error(m);
      await sendStartupError(m);
      return 1;
    }

    log(`Run started${opts.dryRun ? ' (dry run: nothing is submitted or recorded)' : ''}`);
    if (opts.site && !cfg.sites[opts.site].enabled) log(`${SITE_NAMES[opts.site]} is disabled for scheduled runs (sites.${opts.site}.enabled); running it because --site asked for it.`);

    // hand-offs left over from a run whose Telegram send failed go out before anything is retried
    if (!opts.dryRun && tg.enabled) await sendHandoffs(db, tg);
    const st: RunState = { cfg, db, opts, stats: emptyStats(), notes: [], attempts: 0 };
    // --site=<id> runs that site even when it's disabled for scheduled runs
    const sites = SITE_IDS.filter((id) => (opts.site ? opts.site === id : cfg.sites[id].enabled)).filter((id) => {
      if (!ADAPTERS[id]) log(`${SITE_NAMES[id]}: no adapter yet`);
      return !!ADAPTERS[id];
    });
    /** One site in its own tab. The tab is closed afterwards; a crash becomes a run note, never the whole run. */
    const runOne = async (id: SiteId): Promise<SiteEnd> => {
      const siteDry = opts.dryRun || !cfg.sites[id].live;
      if (siteDry && !opts.dryRun) log(`${SITE_NAMES[id]} is not live yet: dry run`);
      let page: Page | undefined;
      try {
        page = await openBackgroundPage(browser as Browser, context);
        pages.push(page);
        return await runSite(st, id, ADAPTERS[id] as SiteAdapter, page, siteDry);
      } catch (e) {
        addNote(st, `${SITE_NAMES[id]}: run crashed (${errMsg(e)}).`);
        return 'done';
      } finally {
        await page?.close().catch(() => {});
      }
    };
    if (cfg.limits.parallelSites && sites.length > 1) {
      // each site gets its own tab; caps, delays and --limit still apply (st.attempts is shared)
      log(`Running ${sites.length} sites in parallel tabs`);
      await Promise.all(sites.map((id) => runOne(id)));
    } else {
      for (const id of sites) if ((await runOne(id)) === 'all') break;
    }

    if (!opts.dryRun && tg.enabled) await sendHandoffs(db, tg);
    await sendSummary(st, tg, new Date());
    if (!opts.dryRun) log(`Report: ${writeReport(db)}`);
    return 0;
  } finally {
    for (const p of pages) await p.close().catch(() => {});
    try {
      await browser?.close(); // disconnects only; the agent Chrome and its other tabs stay open
    } catch (e) {
      log(`Could not disconnect from Chrome: ${errMsg(e)}`);
    }
    try {
      db?.close();
    } catch (e) {
      log(`Could not close the database: ${errMsg(e)}`);
    }
    releaseLock();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
