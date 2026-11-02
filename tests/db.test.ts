// A timezone east of UTC, so local-date logic can't pass by accident on a UTC machine.
process.env.TZ = 'Asia/Kolkata';

import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobDb, questionKey, type JobRecord } from '../src/db.js';

const DAY = 86_400_000;
let db: JobDb;
let n = 0;

function job(over: Partial<JobRecord> = {}): JobRecord {
  n += 1;
  return { site: 'naukri', jobId: `j${n}`, url: `https://example.com/jobs/${n}`, title: 'Frontend Engineer', company: 'Acme',
    status: 'applied', ...over };
}

beforeEach(() => {
  db = new JobDb(':memory:');
});
afterEach(() => db.close());

describe('shouldProcess', () => {
  it('processes new jobs', () => {
    expect(db.shouldProcess('naukri', 'never-seen')).toBe(true);
  });

  it('never reprocesses final statuses', () => {
    for (const status of ['applied', 'skipped', 'company_site', 'already_applied'] as const) {
      const r = job({ status });
      db.recordJob(r);
      expect(db.shouldProcess(r.site, r.jobId), status).toBe(false);
    }
  });

  it('retries failed jobs until the third attempt', () => {
    const r = job({ status: 'failed', reason: 'TIMEOUT' });
    db.recordJob(r);
    expect(db.shouldProcess(r.site, r.jobId)).toBe(true);
    db.recordJob(r);
    expect(db.shouldProcess(r.site, r.jobId)).toBe(true);
    db.recordJob(r);
    expect(db.shouldProcess(r.site, r.jobId)).toBe(false);
  });

  it('retries needs_review while unnotified, without counting attempts', () => {
    const r = job({ status: 'needs_review', reason: 'UNANSWERED_QUESTIONS' });
    for (let i = 0; i < 5; i++) db.recordJob(r);
    expect(db.shouldProcess(r.site, r.jobId)).toBe(true);
    expect(db.jobsOn(new Date().toLocaleDateString('en-CA'))[0].attempts).toBe(0);
  });

  it('never retries a job that may have gone through (NO_CONFIRMATION)', () => {
    const r = job({ status: 'failed', reason: 'NO_CONFIRMATION' });
    db.recordJob(r);
    expect(db.shouldProcess(r.site, r.jobId)).toBe(false);
  });

  it('never reprocesses a notified job', () => {
    const review = job({ status: 'needs_review' });
    const failed = job({ status: 'failed' });
    db.recordJob(review);
    db.recordJob(failed);
    db.markNotified(review.site, review.jobId);
    db.markNotified(failed.site, failed.jobId);
    expect(db.shouldProcess(review.site, review.jobId)).toBe(false);
    expect(db.shouldProcess(failed.site, failed.jobId)).toBe(false);
  });

  it('keeps created_at and notified on a later record, and keeps details not given again', () => {
    const r = job({ status: 'failed', location: 'Pune', detail: 'boom' });
    db.recordJob(r, new Date('2026-10-30T05:00:00Z'));
    db.markNotified(r.site, r.jobId);
    db.recordJob({ site: r.site, jobId: r.jobId, url: r.url, status: 'applied' }, new Date('2026-10-31T05:00:00Z'));
    const row = db.jobsOn('2026-10-31')[0];
    expect(row.created_at).toBe('2026-10-30T05:00:00.000Z');
    expect(row.updated_at).toBe('2026-10-31T05:00:00.000Z');
    expect(row.notified).toBe(1);
    expect(row.status).toBe('applied');
    expect(row.location).toBe('Pune');
    expect(row.title).toBe('Frontend Engineer');
    expect(row.detail).toBeNull();
  });
});

describe('local dates', () => {
  it('counts applied today by local calendar date', () => {
    // 1 Nov 00:15 IST is still 31 Oct in UTC.
    expect(new Date(2026, 10, 1, 0, 15).toISOString()).toBe('2026-10-31T18:45:00.000Z');
    db.recordJob(job(), new Date(2026, 10, 1, 0, 15));
    db.recordJob(job(), new Date(2026, 10, 1, 23, 50));
    db.recordJob(job(), new Date(2026, 9, 31, 23, 45));
    db.recordJob(job({ status: 'skipped' }), new Date(2026, 10, 1, 10, 0));
    db.recordJob(job({ site: 'linkedin' }), new Date(2026, 10, 1, 10, 0));
    expect(db.appliedToday('naukri', new Date(2026, 10, 1, 12, 0))).toBe(2);
    expect(db.appliedToday('naukri', new Date(2026, 9, 31, 12, 0))).toBe(1);
    expect(db.appliedToday('linkedin', new Date(2026, 10, 1, 12, 0))).toBe(1);
  });

  it('lists jobs and notes on a local date, in order', () => {
    db.recordJob(job({ title: 'second' }), new Date(2026, 10, 1, 9, 0));
    db.recordJob(job({ title: 'first' }), new Date(2026, 10, 1, 0, 5));
    db.recordJob(job({ title: 'other day' }), new Date(2026, 10, 2, 0, 5));
    expect(db.jobsOn('2026-11-01').map((r) => r.title)).toEqual(['first', 'second']);

    db.addNote('Naukri: logged out.', new Date(2026, 10, 1, 0, 10));
    db.addNote('LinkedIn: captcha.', new Date(2026, 10, 1, 8, 0));
    db.addNote('yesterday', new Date(2026, 9, 31, 23, 59));
    expect(db.notesOn('2026-11-01')).toEqual(['Naukri: logged out.', 'LinkedIn: captcha.']);
  });
});

describe('unnotifiedHandoffs', () => {
  it('returns hand-off statuses not yet notified within 7 days', () => {
    const now = new Date('2026-11-01T06:00:00Z');
    db.recordJob(job({ jobId: 'cs', status: 'company_site' }), new Date(now.getTime() - DAY));
    db.recordJob(job({ jobId: 'nr', status: 'needs_review' }), new Date(now.getTime() - 6 * DAY));
    db.recordJob(job({ jobId: 'f', status: 'failed' }), now);
    db.recordJob(job({ jobId: 'old', status: 'company_site' }), new Date(now.getTime() - 8 * DAY));
    db.recordJob(job({ jobId: 'done', status: 'company_site' }), now);
    db.recordJob(job({ jobId: 'ok', status: 'applied' }), now);
    db.recordJob(job({ jobId: 'skip', status: 'skipped' }), now);
    db.markNotified('naukri', 'done');
    expect(db.unnotifiedHandoffs(7, now).map((r) => r.job_id)).toEqual(['nr', 'cs', 'f']);
  });
});

describe('appliedElsewhere', () => {
  const now = new Date('2026-11-01T06:00:00Z');

  it('finds an application on a different site with normalized-equal company and title', () => {
    db.recordJob(job({ site: 'linkedin', jobId: 'li1', company: 'Acme Pvt Ltd', title: 'Sr. Frontend Developer' }),
      new Date(now.getTime() - 3 * DAY));
    expect(db.appliedElsewhere('acme', 'Senior Frontend Developer', 'naukri', 21, now)?.job_id).toBe('li1');
  });

  it('ignores the same site, other statuses, other titles, and anything older than 21 days', () => {
    db.recordJob(job({ site: 'naukri', company: 'Acme', title: 'Frontend Engineer' }), now);
    db.recordJob(job({ site: 'linkedin', company: 'Acme', title: 'Frontend Engineer', status: 'company_site' }), now);
    db.recordJob(job({ site: 'linkedin', company: 'Acme', title: 'Backend Engineer' }), now);
    db.recordJob(job({ site: 'instahyre', company: 'Acme', title: 'Frontend Engineer' }), new Date(now.getTime() - 22 * DAY));
    expect(db.appliedElsewhere('Acme', 'Frontend Engineer', 'naukri', 21, now)).toBeUndefined();

    db.recordJob(job({ site: 'instahyre', jobId: 'ih', company: 'Acme', title: 'Frontend Engineer' }),
      new Date(now.getTime() - 20 * DAY));
    expect(db.appliedElsewhere('Acme', 'Frontend Engineer', 'naukri', 21, now)?.job_id).toBe('ih');
  });

  it('never matches on an empty company or title', () => {
    db.recordJob({ site: 'linkedin', jobId: 'blank', url: 'https://example.com/x', status: 'applied' }, now);
    expect(db.appliedElsewhere('', '', 'naukri', 21, now)).toBeUndefined();
    expect(db.appliedElsewhere('Acme', '', 'naukri', 21, now)).toBeUndefined();
  });
});

describe('answers, pending, meta', () => {
  it('saves answers by normalised key and clears the pending question', () => {
    db.addPending('Notice period (in days)? *', 'number', [], 'https://example.com/j');
    db.addPending('Notice period (in days)? *', 'number', [], 'https://example.com/other');
    expect(db.listPending()).toHaveLength(1);
    expect(JSON.parse(db.listPending()[0].options)).toEqual([]);
    db.saveAnswer('notice period (in days)?', '30', 'you');
    expect(db.listPending()).toHaveLength(0);
    expect(db.getAnswer('Notice Period (in days)? (required)')).toBe('30');
    expect(db.getAnswer('Something else')).toBeNull();
    expect(questionKey('Your *Name* (required)')).toBe('your name');
  });

  it('deletes pending by key', () => {
    db.addPending('Why us?', 'textarea', [], 'https://example.com/j');
    db.deletePending(questionKey('Why us?'));
    expect(db.listPending()).toEqual([]);
  });

  it('stores meta values', () => {
    expect(db.getMeta('daily_summary_sent')).toBeNull();
    db.setMeta('daily_summary_sent', '2026-11-01');
    db.setMeta('daily_summary_sent', '2026-11-02');
    expect(db.getMeta('daily_summary_sent')).toBe('2026-11-02');
  });
});

describe('migration from the old schema', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-agent-db-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('adds missing columns, backfills created_at and renames external', () => {
    const file = path.join(dir, 'jobs.db');
    const old = new Database(file);
    old.exec(`
      CREATE TABLE jobs (
        site TEXT NOT NULL, job_id TEXT NOT NULL, url TEXT, title TEXT, company TEXT,
        status TEXT NOT NULL, reason TEXT, resume TEXT, score INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
        PRIMARY KEY (site, job_id)
      );
      CREATE TABLE answers (key TEXT PRIMARY KEY, question TEXT, answer TEXT, source TEXT, updated_at TEXT);
      CREATE TABLE pending_questions (key TEXT PRIMARY KEY, question TEXT, kind TEXT, options TEXT, job_url TEXT, created_at TEXT);
      INSERT INTO jobs VALUES ('naukri', 'ext1', 'https://example.com/1', 'UI Developer', 'Beta', 'external', 'company site', 'frontend', 7, 0, '2026-10-20T04:00:00.000Z');
      INSERT INTO jobs VALUES ('linkedin', 'app1', 'https://example.com/2', 'Frontend Engineer', 'Acme', 'applied', NULL, 'frontend', 8, 0, '2026-10-25T04:00:00.000Z');
      INSERT INTO jobs VALUES ('naukri', 'fail1', 'https://example.com/3', 'React Developer', 'Gamma', 'failed', 'timeout', NULL, NULL, 2, '2026-10-25T05:00:00.000Z');
    `);
    old.close();

    const jdb = new JobDb(file);
    const ext = jdb.jobsOn('2026-10-20')[0];
    expect(ext.status).toBe('company_site');
    expect(ext.created_at).toBe('2026-10-20T04:00:00.000Z');
    expect(ext.notified).toBe(0);
    expect(ext.external_url).toBeNull();
    expect(jdb.shouldProcess('naukri', 'ext1')).toBe(false);
    expect(jdb.shouldProcess('naukri', 'fail1')).toBe(true);

    jdb.recordJob({ site: 'naukri', jobId: 'fail1', url: 'https://example.com/3', status: 'failed', detail: 'again' },
      new Date('2026-10-26T05:00:00Z'));
    expect(jdb.shouldProcess('naukri', 'fail1')).toBe(false);
    expect(jdb.appliedElsewhere('Acme', 'Frontend Engineer', 'naukri', 21, new Date('2026-11-01T00:00:00Z'))?.job_id).toBe('app1');
    jdb.addNote('migrated', new Date('2026-10-26T05:00:00Z'));
    jdb.setMeta('k', 'v');
    jdb.close();

    // Opening again is a no-op migration.
    const again = new JobDb(file);
    expect(again.getMeta('k')).toBe('v');
    expect(again.jobsOn('2026-10-26')[0].attempts).toBe(3);
    again.close();
  });
});
