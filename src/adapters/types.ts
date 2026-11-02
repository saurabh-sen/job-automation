import type { Page } from 'playwright-core';
import type { Config, SiteId } from '../config.js';
import type { Answerer } from '../answers.js';

export type { SiteId };

export interface JobRef {
  site: SiteId;
  jobId: string;
  url: string;
}

export interface JobDetails extends JobRef {
  title: string;
  company: string;
  /** Includes the workplace type if shown (Remote / Hybrid / On-site). */
  location: string;
  /** As shown, e.g. "2-5 Yrs". */
  experience?: string;
  salary?: string;
  /** As shown, e.g. "3 hours ago". */
  postedAt?: string;
  applicants?: string;
  description: string;
  applyType: 'in_site' | 'company_site' | 'already_applied' | 'unknown';
}

export type ReasonCode =
  | 'COMPANY_SITE' | 'UNANSWERED_QUESTIONS' | 'NO_CONFIRMATION' | 'SELECTOR_MISSING'
  | 'FORM_REJECTED' | 'TIMEOUT' | 'CHECKPOINT' | 'UNKNOWN'
  /** The site's own application limit (e.g. Work at a Startup: 5 per week). Stops the site; the job is not recorded. */
  | 'SITE_LIMIT';

export interface ApplyOutcome {
  status: 'applied' | 'company_site' | 'needs_review' | 'failed' | 'already_applied';
  reason?: ReasonCode;
  /** Human-readable, e.g. the unanswered questions joined with "\n". */
  detail?: string;
  /** Company apply link, if captured. */
  externalUrl?: string;
}

export interface ApplyContext {
  cfg: Config;
  answers: Answerer;
  /** Do everything up to, but not including, the final Submit/Send click. */
  dryRun: boolean;
}

/**
 * One file per site implements this, with its selectors as named constants at the top.
 * Expected cases come back as an ApplyOutcome; only truly unexpected errors throw.
 */
export interface SiteAdapter {
  id: SiteId;
  isLoggedIn(page: Page): Promise<boolean>;
  collectJobs(page: Page, cfg: Config): Promise<JobRef[]>;
  getDetails(page: Page, ref: JobRef): Promise<JobDetails>;
  /**
   * In dry-run: stops before the final click, calls abandon(), returns { status: 'applied', detail: 'dry-run' }.
   * Sites where the first Apply click already submits (Naukri) stop before that click.
   */
  apply(page: Page, job: JobDetails, ctx: ApplyContext): Promise<ApplyOutcome>;
  /**
   * The company's apply URL. Reads it from the page when possible; otherwise (live only) opens the popup, reads its
   * final URL and closes it without touching it. In dry runs it must not click anything.
   */
  captureExternalUrl?(page: Page, job: JobDetails, dryRun: boolean): Promise<string | undefined>;
  /** Closes any half-filled form without submitting. */
  abandon(page: Page): Promise<void>;
}
