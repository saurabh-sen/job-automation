import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JobDb, type JobRow } from '../src/db.js';
import { buildReport, skipGroup, writeReport } from '../src/report.js';

let n = 0;
function row(over: Partial<JobRow>): JobRow {
  n += 1;
  return {
    site: 'naukri', job_id: `j${n}`, url: `https://example.com/jobs/${n}`, external_url: null, title: `Frontend Engineer ${n}`,
    company: 'Acme', location: null, experience: null, salary: null, posted_at: null, applicants: null, status: 'applied',
    reason: null, detail: null, attempts: 0, notified: 0, created_at: '2026-11-01T03:00:00.000Z',
    updated_at: '2026-11-01T03:00:00.000Z', ...over,
  };
}

describe('skipGroup', () => {
  it('groups experience reasons that differ only in the number', () => {
    expect(skipGroup('needs 6+ yrs')).toEqual({ key: 'needs N+ yrs', value: '6' });
    expect(skipGroup('needs 7+ yrs').key).toBe(skipGroup('needs 6+ yrs').key);
  });

  it('groups quoted keywords, bracketed companies and locations', () => {
    expect(skipGroup('title has "lead"')).toEqual({ key: 'title has "…"', value: 'lead' });
    expect(skipGroup('title has "manager"').key).toBe('title has "…"');
    expect(skipGroup('excluded company (examplecorp)')).toEqual({ key: 'excluded company (…)', value: 'examplecorp' });
    expect(skipGroup('location: Mumbai, Maharashtra')).toEqual({ key: 'location', value: 'Mumbai, Maharashtra' });
    expect(skipGroup('location: Delhi').key).toBe('location');
  });

  it('keeps fixed reasons as they are', () => {
    expect(skipGroup('not a target role')).toEqual({ key: 'not a target role' });
    expect(skipGroup('applied via LinkedIn')).toEqual({ key: 'applied via LinkedIn' });
    expect(skipGroup(null)).toEqual({ key: 'other' });
    expect(skipGroup('  ')).toEqual({ key: 'other' });
  });
});

describe('buildReport', () => {
  const rows: JobRow[] = [
    row({ site: 'linkedin', title: 'UI Engineer', company: 'Beta' }),
    row({ site: 'naukri', title: 'React Developer', company: 'Gamma' }),
    row({ status: 'skipped', reason: 'needs 6+ yrs' }),
    row({ status: 'skipped', reason: 'needs 7+ yrs' }),
    row({ status: 'skipped', reason: 'needs 6+ yrs' }),
    row({ status: 'skipped', reason: 'title has "lead"' }),
    row({ status: 'skipped', reason: 'title has "manager"' }),
    row({ status: 'skipped', reason: 'not a target role' }),
    row({ status: 'company_site', reason: 'COMPANY_SITE', external_url: 'https://careers.example.com/apply/1' }),
    row({ status: 'needs_review', reason: 'UNANSWERED_QUESTIONS', detail: 'Do you have a passport?\nWhy us?' }),
    row({ status: 'failed', reason: 'NO_CONFIRMATION' }),
    row({ status: 'already_applied' }),
  ];
  const md = buildReport('2026-11-01', rows, ['Naukri: logged out.'], 2);

  it('has the counts line', () => {
    expect(md).toContain('Applied 2 · Sent to you 3 · Skipped 6 · Failed 1 · Already applied 1');
  });

  it('groups skips by reason with counts, most common first', () => {
    const skipped = md.slice(md.indexOf('## Skipped by reason (6)'));
    const lines = skipped.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toEqual([
      '- needs N+ yrs: 3 (6 ×2, 7)',
      '- title has "…": 2 (lead, manager)',
      '- not a target role: 1',
    ]);
  });

  it('lists applied per site and the hand-offs', () => {
    expect(md).toContain('### LinkedIn (1)');
    expect(md).toContain('### Naukri (1)');
    expect(md.indexOf('### LinkedIn')).toBeLessThan(md.indexOf('### Naukri'));
    expect(md).toContain('[apply here](https://careers.example.com/apply/1)');
    expect(md).toContain('  - Do you have a passport?');
    expect(md).toContain('  - Why us?');
    expect(md).toMatch(/Could not finish \(1\)[\s\S]*no confirmation after Submit/);
    expect(md).toContain('## Run notes');
    expect(md).toContain('- Naukri: logged out.');
    expect(md).toContain('2 question(s) waiting');
    expect(md).toContain('npm run review');
  });

  it('handles an empty day', () => {
    const empty = buildReport('2026-11-01', [], [], 0);
    expect(empty).toContain('Applied 0 · Sent to you 0 · Skipped 0 · Failed 0 · Already applied 0');
    expect(empty).not.toContain('Skipped by reason');
    expect(empty).not.toContain('npm run review');
    expect(empty).not.toContain('Run notes');
  });

  it('puts the pending questions hint last', () => {
    expect(md.trimEnd().split('\n').at(-1)).toContain('npm run review');
  });
});

describe('writeReport', () => {
  it('writes reports/<date>.md with the whole day, its notes and the pending count', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-agent-report-'));
    const db = new JobDb(':memory:');
    try {
      // Built from local time, so the local day is 2026-11-01 whatever the machine's timezone.
      const at = new Date(2026, 10, 1, 12, 0);
      const date = '2026-11-01';
      db.recordJob({ site: 'naukri', jobId: 'a', url: 'https://example.com/a', title: 'UI Engineer', company: 'Beta', status: 'applied' }, at);
      db.recordJob({ site: 'linkedin', jobId: 'b', url: 'https://example.com/b', status: 'skipped', reason: 'needs 6+ yrs' }, at);
      db.recordJob({ site: 'naukri', jobId: 'old', url: 'https://example.com/old', status: 'applied' }, new Date(2026, 9, 30, 12, 0));
      db.addNote('LinkedIn: logged out.', at);
      db.addNote('older note', new Date(2026, 9, 30, 12, 0));
      db.addPending('Why us?', 'textarea', [], 'https://example.com/b');

      const file = writeReport(db, date, dir);
      expect(file).toBe(path.resolve(dir, '2026-11-01.md'));
      const md = fs.readFileSync(file, 'utf8');
      expect(md).toContain('# Job agent report · 2026-11-01');
      expect(md).toContain('Applied 1 · Sent to you 0 · Skipped 1 · Failed 0 · Already applied 0');
      expect(md).toContain('[UI Engineer](https://example.com/a)');
      expect(md).toContain('- LinkedIn: logged out.');
      expect(md).not.toContain('older note');
      expect(md).toContain('1 question(s) waiting');

      // Rewritten, not appended, on the next run.
      writeReport(db, date, dir);
      expect(fs.readFileSync(file, 'utf8')).toBe(md);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
