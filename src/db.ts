import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { SiteId } from './config.js';
import { normalizeCompany, normalizeTitle } from './filters.js';
import { localDate } from './utils.js';

export type JobStatus = 'applied' | 'skipped' | 'company_site' | 'needs_review' | 'failed' | 'already_applied';

/** Never processed again. */
export const FINAL_STATUSES: JobStatus[] = ['applied', 'skipped', 'company_site', 'already_applied'];
/** Sent to Telegram for a human to finish. */
export const HANDOFF_STATUSES: JobStatus[] = ['company_site', 'needs_review', 'failed'];

const MAX_ATTEMPTS = 3;

export interface JobRecord {
  site: SiteId; jobId: string; url: string; externalUrl?: string; title?: string; company?: string;
  location?: string; experience?: string; salary?: string; postedAt?: string; applicants?: string;
  status: JobStatus; reason?: string; detail?: string;
}

export interface JobRow {
  site: SiteId; job_id: string; url: string; external_url: string | null; title: string | null;
  company: string | null; location: string | null; experience: string | null; salary: string | null; posted_at: string | null;
  applicants: string | null; status: JobStatus; reason: string | null; detail: string | null; attempts: number;
  notified: number; created_at: string; updated_at: string;
}

export interface PendingRow {
  key: string; question: string; kind: string;
  /** JSON string[] */
  options: string;
  job_url: string; created_at: string;
}

export const questionKey = (q: string) =>
  q.toLowerCase().replace(/\(required\)|\brequired\b|\*/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS jobs (
    site TEXT NOT NULL,
    job_id TEXT NOT NULL,
    url TEXT NOT NULL,
    external_url TEXT,
    title TEXT, company TEXT, location TEXT, experience TEXT, salary TEXT,
    posted_at TEXT, applicants TEXT,
    status TEXT NOT NULL,
    reason TEXT,
    detail TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    notified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (site, job_id)
  );
  CREATE TABLE IF NOT EXISTS answers (
    key TEXT PRIMARY KEY, question TEXT, answer TEXT, source TEXT, updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS pending_questions (
    key TEXT PRIMARY KEY, question TEXT, kind TEXT, options TEXT, job_url TEXT, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS run_notes (created_at TEXT NOT NULL, text TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

/** Columns added since the first schema, as `ALTER TABLE ADD COLUMN` definitions. */
const JOB_COLUMNS: Array<[string, string]> = [
  ['url', "TEXT NOT NULL DEFAULT ''"],
  ['external_url', 'TEXT'],
  ['title', 'TEXT'],
  ['company', 'TEXT'],
  ['location', 'TEXT'],
  ['experience', 'TEXT'],
  ['salary', 'TEXT'],
  ['posted_at', 'TEXT'],
  ['applicants', 'TEXT'],
  ['reason', 'TEXT'],
  ['detail', 'TEXT'],
  ['attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ['notified', 'INTEGER NOT NULL DEFAULT 0'],
  ['created_at', "TEXT NOT NULL DEFAULT ''"],
  ['updated_at', "TEXT NOT NULL DEFAULT ''"],
];

/** UTC ISO bounds [start, end) of a local calendar day 'YYYY-MM-DD'. */
function localDayBounds(date: string): [string, string] {
  const [y, m, d] = date.split('-').map(Number);
  return [new Date(y, m - 1, d).toISOString(), new Date(y, m - 1, d + 1).toISOString()];
}

export class JobDb {
  private db: Database.Database;

  constructor(file = 'data/jobs.db') {
    const memory = file === ':memory:';
    if (!memory) fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new Database(memory ? file : path.resolve(file));
    if (!memory) this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  private migrate() {
    const have = new Set((this.db.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>).map((c) => c.name));
    for (const [name, def] of JOB_COLUMNS) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${def}`);
    }
    this.db.exec(`
      UPDATE jobs SET created_at = updated_at WHERE created_at IS NULL OR created_at = '';
      UPDATE jobs SET status = 'company_site' WHERE status = 'external';
    `);
  }

  /** New, or failed / needs_review that hasn't been handed off and has attempts left. */
  shouldProcess(site: SiteId, jobId: string): boolean {
    const row = this.db.prepare('SELECT status, reason, attempts, notified FROM jobs WHERE site = ? AND job_id = ?').get(site, jobId) as
      | { status: JobStatus; reason: string | null; attempts: number; notified: number }
      | undefined;
    if (!row) return true;
    // NO_CONFIRMATION may have gone through: never re-apply it automatically
    if (row.reason === 'NO_CONFIRMATION') return false;
    return (row.status === 'failed' || row.status === 'needs_review') && row.notified === 0 && row.attempts < MAX_ATTEMPTS;
  }

  /** Upsert. attempts goes up only on `failed`; created_at and notified are kept. Missing details keep earlier values. */
  recordJob(r: JobRecord, now = new Date()): void {
    const at = now.toISOString();
    this.db.prepare(`
      INSERT INTO jobs (site, job_id, url, external_url, title, company, location, experience, salary, posted_at, applicants,
                        status, reason, detail, attempts, notified, created_at, updated_at)
      VALUES (@site, @jobId, @url, @externalUrl, @title, @company, @location, @experience, @salary, @postedAt, @applicants,
              @status, @reason, @detail, @fail, 0, @at, @at)
      ON CONFLICT(site, job_id) DO UPDATE SET
        url = excluded.url,
        external_url = COALESCE(excluded.external_url, jobs.external_url),
        title = COALESCE(excluded.title, jobs.title),
        company = COALESCE(excluded.company, jobs.company),
        location = COALESCE(excluded.location, jobs.location),
        experience = COALESCE(excluded.experience, jobs.experience),
        salary = COALESCE(excluded.salary, jobs.salary),
        posted_at = COALESCE(excluded.posted_at, jobs.posted_at),
        applicants = COALESCE(excluded.applicants, jobs.applicants),
        status = excluded.status,
        reason = excluded.reason,
        detail = excluded.detail,
        attempts = jobs.attempts + excluded.attempts,
        updated_at = excluded.updated_at
    `).run({
      site: r.site, jobId: r.jobId, url: r.url, externalUrl: r.externalUrl ?? null, title: r.title ?? null,
      company: r.company ?? null, location: r.location ?? null, experience: r.experience ?? null, salary: r.salary ?? null,
      postedAt: r.postedAt ?? null, applicants: r.applicants ?? null, status: r.status, reason: r.reason ?? null,
      detail: r.detail ?? null, fail: r.status === 'failed' ? 1 : 0, at,
    });
  }

  /** Applications recorded for the site on the local calendar day of `now`. */
  appliedToday(site: SiteId, now = new Date()): number {
    const [start, end] = localDayBounds(localDate(now));
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM jobs WHERE site = ? AND status = 'applied' AND updated_at >= ? AND updated_at < ?
    `).get(site, start, end) as { n: number };
    return row.n;
  }

  /** Jobs last updated on a local date 'YYYY-MM-DD'. */
  jobsOn(date: string): JobRow[] {
    const [start, end] = localDayBounds(date);
    return this.db.prepare('SELECT * FROM jobs WHERE updated_at >= ? AND updated_at < ? ORDER BY updated_at')
      .all(start, end) as JobRow[];
  }

  /** Hand-off jobs not yet sent to Telegram, updated within the last `days`. */
  unnotifiedHandoffs(days = 7, now = new Date()): JobRow[] {
    const since = new Date(now.getTime() - days * 86_400_000).toISOString();
    const marks = HANDOFF_STATUSES.map(() => '?').join(', ');
    return this.db.prepare(`
      SELECT * FROM jobs WHERE status IN (${marks}) AND notified = 0 AND updated_at >= ? ORDER BY updated_at
    `).all(...HANDOFF_STATUSES, since) as JobRow[];
  }

  markNotified(site: SiteId, jobId: string): void {
    this.db.prepare('UPDATE jobs SET notified = 1 WHERE site = ? AND job_id = ?').run(site, jobId);
  }

  /** The most recent application on another site to the same company and a normalized-equal title. */
  appliedElsewhere(company: string, title: string, site: SiteId, days = 21, now = new Date()): JobRow | undefined {
    const c = normalizeCompany(company);
    const t = normalizeTitle(title);
    if (!c || !t) return undefined;
    const since = new Date(now.getTime() - days * 86_400_000).toISOString();
    const rows = this.db.prepare(`
      SELECT * FROM jobs WHERE status = 'applied' AND site != ? AND updated_at >= ? ORDER BY updated_at DESC
    `).all(site, since) as JobRow[];
    return rows.find((r) => normalizeCompany(r.company ?? '') === c && normalizeTitle(r.title ?? '') === t);
  }

  addNote(text: string, now = new Date()): void {
    this.db.prepare('INSERT INTO run_notes (created_at, text) VALUES (?, ?)').run(now.toISOString(), text);
  }

  /** Run notes written on a local date 'YYYY-MM-DD', oldest first. */
  notesOn(date: string): string[] {
    const [start, end] = localDayBounds(date);
    return (this.db.prepare('SELECT text FROM run_notes WHERE created_at >= ? AND created_at < ? ORDER BY created_at, rowid')
      .all(start, end) as Array<{ text: string }>).map((r) => r.text);
  }

  getAnswer(question: string): string | null {
    const row = this.db.prepare('SELECT answer FROM answers WHERE key = ?').get(questionKey(question)) as
      | { answer: string | null }
      | undefined;
    return row?.answer ?? null;
  }

  /** Saves the answer and clears the matching pending question. */
  saveAnswer(question: string, answer: string, source: 'you' | 'llm'): void {
    const key = questionKey(question);
    this.db.prepare(`
      INSERT INTO answers (key, question, answer, source, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET answer = excluded.answer, source = excluded.source, updated_at = excluded.updated_at
    `).run(key, question, answer, source, new Date().toISOString());
    this.deletePending(key);
  }

  addPending(question: string, kind: string, options: string[], jobUrl: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO pending_questions (key, question, kind, options, job_url, created_at) VALUES (?, ?, ?, ?, ?, ?)
    `).run(questionKey(question), question, kind, JSON.stringify(options), jobUrl, new Date().toISOString());
  }

  listPending(): PendingRow[] {
    return this.db.prepare('SELECT * FROM pending_questions ORDER BY created_at').all() as PendingRow[];
  }

  deletePending(key: string): void {
    this.db.prepare('DELETE FROM pending_questions WHERE key = ?').run(key);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string | null } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  close(): void {
    this.db.close();
  }
}
