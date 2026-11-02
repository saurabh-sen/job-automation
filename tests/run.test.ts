import { describe, expect, it, vi } from 'vitest';

// keep this test independent of the adapters and Chrome (and of their in-progress state)
vi.mock('../src/adapters/index.js', () => ({ ADAPTERS: {} }));
vi.mock('../src/browser.js', () => ({ connectBrowser: vi.fn() }));

const {
  activityOf, countJob, countsInSummary, emptyStats, parseRunArgs, statsFromRows, statusLabel, summaryDecision, summaryHeader,
} = await import('../src/run.js');

const base = { activity: 0, notes: 0, dailySummaryAfter: '19:30', dailySentOn: null, dryRun: false };
const at = (h: number, m: number) => new Date(2026, 10, 1, h, m); // local time, 1 Nov 2026

describe('summaryDecision', () => {
  it('sends nothing for a quiet run before the cutoff', () => {
    expect(summaryDecision({ ...base, now: at(11, 30) })).toBe('none');
  });

  it('sends a run summary when something happened or there are notes', () => {
    expect(summaryDecision({ ...base, now: at(11, 30), activity: 1 })).toBe('run');
    expect(summaryDecision({ ...base, now: at(11, 30), notes: 1 })).toBe('run');
  });

  it('sends the day summary from the cutoff on, even when nothing happened', () => {
    expect(summaryDecision({ ...base, now: at(19, 30) })).toBe('day');
    expect(summaryDecision({ ...base, now: at(20, 0) })).toBe('day');
    expect(summaryDecision({ ...base, now: at(19, 29), activity: 3 })).toBe('run');
  });

  it('sends the day summary only once per day', () => {
    expect(summaryDecision({ ...base, now: at(20, 0), dailySentOn: '2026-11-01' })).toBe('none');
    expect(summaryDecision({ ...base, now: at(20, 0), dailySentOn: '2026-11-01', activity: 2 })).toBe('run');
    expect(summaryDecision({ ...base, now: at(20, 0), dailySentOn: '2026-10-31' })).toBe('day');
  });

  it('never sends a day summary for a dry run', () => {
    expect(summaryDecision({ ...base, now: at(20, 0), dryRun: true })).toBe('none');
    expect(summaryDecision({ ...base, now: at(20, 0), dryRun: true, notes: 1 })).toBe('run');
  });

  it('compares times numerically', () => {
    expect(summaryDecision({ ...base, now: at(9, 5), dailySummaryAfter: '08:00' })).toBe('day');
    expect(summaryDecision({ ...base, now: at(7, 59), dailySummaryAfter: '08:00' })).toBe('none');
  });
});

describe('stats', () => {
  it('counts applied per site, hand-offs, skips and failures', () => {
    const s = emptyStats();
    countJob(s, 'naukri', 'applied');
    countJob(s, 'naukri', 'applied');
    countJob(s, 'linkedin', 'applied');
    countJob(s, 'linkedin', 'company_site');
    countJob(s, 'linkedin', 'needs_review');
    countJob(s, 'naukri', 'failed');
    countJob(s, 'naukri', 'skipped');
    countJob(s, 'naukri', 'already_applied');
    expect(s).toEqual({ applied: { naukri: 2, linkedin: 1 }, sentToYou: 3, skipped: 1, failed: 1 });
    expect(activityOf(s)).toBe(6);
  });

  it('skips and already-applied are not activity', () => {
    const s = statsFromRows([
      { site: 'naukri', status: 'skipped' },
      { site: 'linkedin', status: 'already_applied' },
    ]);
    expect(activityOf(s)).toBe(0);
    expect(s.skipped).toBe(1);
  });

  it('builds whole-day stats from rows', () => {
    const s = statsFromRows([
      { site: 'wellfound', status: 'applied' },
      { site: 'wellfound', status: 'failed' },
    ]);
    expect(s).toEqual({ applied: { wellfound: 1 }, sentToYou: 1, skipped: 0, failed: 1 });
  });
});

describe('countsInSummary', () => {
  it('leaves forced-dry sites out of a real run summary', () => {
    expect(countsInSummary(false, false)).toBe(true); // live site, real run
    expect(countsInSummary(true, false)).toBe(false); // not-live site in a real run: nothing submitted or recorded
    expect(countsInSummary(true, true)).toBe(true); // --dry-run: show what would happen
  });
});

describe('summaryHeader', () => {
  it('formats run and day headers', () => {
    expect(summaryHeader('run', new Date(2026, 10, 1, 9, 5), false)).toBe('Job agent · 1 Nov, 09:05');
    expect(summaryHeader('day', new Date(2026, 8, 30, 20, 0), false)).toBe('Job agent · 30 Sep (day summary)');
    expect(summaryHeader('run', new Date(2026, 10, 1, 11, 30), true)).toBe('(dry run) Job agent · 1 Nov, 11:30');
  });
});

describe('statusLabel', () => {
  it('labels dry-run applies as WOULD APPLY', () => {
    expect(statusLabel('applied', false)).toBe('APPLIED');
    expect(statusLabel('applied', true)).toBe('WOULD APPLY');
    expect(statusLabel('company_site', true)).toBe('COMPANY SITE');
    expect(statusLabel('needs_review', false)).toBe('NEEDS REVIEW');
    expect(statusLabel('already_applied', false)).toBe('ALREADY APPLIED');
    expect(statusLabel('skipped', false)).toBe('SKIPPED');
    expect(statusLabel('failed', false)).toBe('FAILED');
  });
});

describe('parseRunArgs', () => {
  it('parses the flags', () => {
    expect(parseRunArgs([])).toEqual({ dryRun: false });
    expect(parseRunArgs(['--dry-run', '--site=naukri', '--limit=3'])).toEqual({ dryRun: true, site: 'naukri', limit: 3 });
  });

  it('rejects unknown sites, bad limits and unknown flags', () => {
    expect(() => parseRunArgs(['--site=indeed'])).toThrow(/Unknown site "indeed"/);
    expect(() => parseRunArgs(['--limit=0'])).toThrow(/--limit/);
    expect(() => parseRunArgs(['--limit=abc'])).toThrow(/--limit/);
    expect(() => parseRunArgs(['--limit=2.5'])).toThrow(/--limit/);
    expect(() => parseRunArgs(['--dryrun'])).toThrow(/Unknown option/);
  });
});
