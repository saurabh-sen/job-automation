import { describe, expect, it, vi } from 'vitest';
import type { JobRow } from '../src/db.js';
import { escapeHtml, formatHandoff, formatSummary, stripHtml, Telegram } from '../src/telegram.js';

const TOKEN = '123456:FAKE-token';
const tgCfg = { enabled: true, botToken: TOKEN, chatId: '42', dailySummaryAfter: '19:30' };

function row(over: Partial<JobRow> = {}): JobRow {
  return {
    site: 'linkedin', job_id: '123', url: 'https://www.linkedin.com/jobs/view/123/', external_url: null,
    title: 'Frontend Engineer', company: 'Acme', location: null, experience: null, salary: null, posted_at: null,
    applicants: null, status: 'company_site', reason: null, detail: null, attempts: 0, notified: 0,
    created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}

describe('escapeHtml', () => {
  it('escapes & < > "', () => {
    expect(escapeHtml('a & b <c> "d"')).toBe('a &amp; b &lt;c&gt; &quot;d&quot;');
  });
  it('escapes & first (no double escaping of its own output)', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
  it('round-trips through stripHtml', () => {
    expect(stripHtml(`<b>${escapeHtml('R&D <UI> "x"')}</b>`)).toBe('R&D <UI> "x"');
  });
});

describe('formatHandoff', () => {
  it('company site with all metadata and the apply link', () => {
    const msg = formatHandoff(row({
      location: 'Hyderabad (Hybrid)', experience: '2–5 yrs', salary: '₹18–25 LPA', posted_at: '3 hours ago',
      applicants: '40', external_url: 'https://acme.greenhouse.io/jobs/1?a=1&b=2',
    }));
    expect(msg).toBe([
      'Apply on company site · LinkedIn',
      '<b>Frontend Engineer</b> at Acme',
      'Hyderabad (Hybrid) · 2–5 yrs · ₹18–25 LPA · posted 3 hours ago · 40 applicants',
      'Apply here: https://acme.greenhouse.io/jobs/1?a=1&amp;b=2',
      'Job post: https://www.linkedin.com/jobs/view/123/',
    ].join('\n'));
  });

  it('shows only the metadata that exists and skips the metadata line when there is none', () => {
    expect(formatHandoff(row({ location: 'Pune', salary: 'Not disclosed' }))).toContain('\nPune · Not disclosed\n');
    const bare = formatHandoff(row());
    expect(bare.split('\n')).toEqual([
      'Apply on company site · LinkedIn',
      '<b>Frontend Engineer</b> at Acme',
      'Job post: https://www.linkedin.com/jobs/view/123/',
    ]);
  });

  it('does not double "posted" or "applicants"', () => {
    const msg = formatHandoff(row({ posted_at: 'Posted 2 days ago', applicants: 'Over 100 applicants' }));
    expect(msg).toContain('Posted 2 days ago · Over 100 applicants');
    expect(msg).not.toMatch(/posted posted|applicants applicants/i);
  });

  it('needs review lists each question', () => {
    const msg = formatHandoff(row({
      site: 'naukri', url: 'https://www.naukri.com/job-listings-1', title: 'Full Stack Developer', company: 'Beta',
      location: 'Bengaluru', experience: '3–6 yrs', salary: 'Not disclosed', status: 'needs_review',
      reason: 'UNANSWERED_QUESTIONS',
      detail: 'Are you comfortable with a 6-day work week?\n\nRate your Kotlin skills out of 10 (1 < 10)',
    }));
    expect(msg).toBe([
      'Needs your answers · Naukri',
      '<b>Full Stack Developer</b> at Beta',
      'Bengaluru · 3–6 yrs · Not disclosed',
      '• Are you comfortable with a 6-day work week?',
      '• Rate your Kotlin skills out of 10 (1 &lt; 10)',
      'Job post: https://www.naukri.com/job-listings-1',
    ].join('\n'));
  });

  it('stays within the Telegram limit with many long questions and keeps the job link', () => {
    const url = `https://www.naukri.com/job-listings-${'x'.repeat(400)}`;
    const detail = Array.from({ length: 30 }, (_, i) => `Question ${i} ${'& long text '.repeat(40)}`).join('\n');
    const msg = formatHandoff(row({ status: 'needs_review', url, detail }));
    expect(stripHtml(msg).length).toBeLessThanOrEqual(4096);
    expect(msg.endsWith(`Job post: ${url}`)).toBe(true);
    expect(msg).toMatch(/\n…and \d+ more\n/);
    expect(msg).toContain('• Question 0 ');
  });

  it('failed shows a human reason', () => {
    const msg = formatHandoff(row({
      site: 'wellfound', url: 'https://wellfound.com/jobs/1', title: 'React Engineer', company: 'Gamma',
      status: 'failed', reason: 'NO_CONFIRMATION',
    }));
    expect(msg).toBe([
      'Agent could not finish · Wellfound',
      '<b>React Engineer</b> at Gamma',
      'Reason: no confirmation after Send. It may have gone through; check before re-applying.',
      'Job post: https://wellfound.com/jobs/1',
    ].join('\n'));
    const reason = (reason: string, detail: string | null = null) =>
      formatHandoff(row({ status: 'failed', reason, detail })).split('\n').find((l) => l.startsWith('Reason: '));
    expect(reason('NO_CONFIRMATION')).toContain('after Submit');
    expect(reason('FORM_REJECTED', 'Enter a valid <number>')).toBe('Reason: the form rejected an answer: Enter a valid &lt;number&gt;');
    expect(reason('SELECTOR_MISSING', 'no Apply button found')).toBe('Reason: the page layout changed (no Apply button found)');
    expect(reason('TIMEOUT', 'locator.click: Timeout 30000ms')).toBe('Reason: the page timed out');
    expect(reason('CHECKPOINT')).toMatch(/captcha/);
    expect(reason('UNKNOWN', 'boom')).toBe('Reason: boom');
  });

  it('escapes title, company and urls', () => {
    const msg = formatHandoff(row({ title: 'C++ <Dev>', company: 'A & B "Co"', url: 'https://x.test/?a=1&b=2' }));
    expect(msg).toContain('<b>C++ &lt;Dev&gt;</b> at A &amp; B &quot;Co&quot;');
    expect(msg).toContain('Job post: https://x.test/?a=1&amp;b=2');
  });

  it('copes with a missing title or company', () => {
    expect(formatHandoff(row({ title: null, company: null }))).toContain('\n<b>Untitled job</b>\n');
  });
});

describe('formatSummary', () => {
  it('lists applied per site in site order, then counts and notes', () => {
    const msg = formatSummary({
      header: 'Job agent · 31 Oct',
      applied: { naukri: 9, linkedin: 8, wellfound: 0 },
      sentToYou: 6, skipped: 41, failed: 1,
      notes: ['Naukri: stopped at a captcha. Clear it in Chrome; the next run continues.', 'LinkedIn: logged out <again>'],
    });
    expect(msg).toBe([
      '<b>Job agent · 31 Oct</b>',
      'Applied 17 (LinkedIn 8 · Naukri 9)',
      'Sent to you 6 · Skipped 41 · Failed 1',
      'Naukri: stopped at a captcha. Clear it in Chrome; the next run continues.',
      'LinkedIn: logged out &lt;again&gt;',
    ].join('\n'));
  });

  it('has no parentheses when nothing was applied', () => {
    const msg = formatSummary({ header: 'Job agent · 1 Nov', applied: {}, sentToYou: 0, skipped: 0, failed: 0, notes: [] });
    expect(msg).toBe('<b>Job agent · 1 Nov</b>\nApplied 0\nSent to you 0 · Skipped 0 · Failed 0');
  });
});

/** A fake Bot API: replies in order, records each call. Time only moves through the fake sleep. */
function fakeApi(replies: Array<{ status: number; body: unknown }>) {
  let t = 1_000_000;
  const sleeps: number[] = [];
  const calls: Array<{ url: string; body: Record<string, unknown>; at: number }> = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), at: t });
    const r = replies.length > 1 ? replies.shift()! : replies[0];
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
  const deps = {
    fetch: fetch as unknown as typeof globalThis.fetch,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    now: () => t,
  };
  return { fetch, deps, sleeps, calls };
}

const OK = { status: 200, body: { ok: true, result: {} } };
const TOO_MANY = { status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests: retry after 5', parameters: { retry_after: 5 } } };

describe('Telegram.send', () => {
  it('sends HTML with link previews off', async () => {
    const api = fakeApi([OK]);
    const tg = new Telegram(tgCfg, api.deps);
    expect(await tg.send('<b>hi</b>')).toBe(true);
    expect(api.calls[0].url).toMatch(/\/sendMessage$/);
    expect(api.calls[0].body).toEqual({
      chat_id: '42', text: '<b>hi</b>', parse_mode: 'HTML', link_preview_options: { is_disabled: true },
    });
  });

  it('spaces messages at least 1.1 s apart', async () => {
    const api = fakeApi([OK]);
    const tg = new Telegram(tgCfg, api.deps);
    for (let i = 0; i < 3; i++) expect(await tg.send(`m${i}`)).toBe(true);
    expect(api.calls).toHaveLength(3);
    expect(api.calls[1].at - api.calls[0].at).toBeGreaterThanOrEqual(1100);
    expect(api.calls[2].at - api.calls[1].at).toBeGreaterThanOrEqual(1100);
  });

  it('waits retry_after on 429, then succeeds', async () => {
    const api = fakeApi([TOO_MANY, OK]);
    const tg = new Telegram(tgCfg, api.deps);
    expect(await tg.send('x')).toBe(true);
    expect(api.fetch).toHaveBeenCalledTimes(2);
    expect(api.sleeps).toContain(5000);
    expect(api.calls[1].at - api.calls[0].at).toBeGreaterThanOrEqual(5000);
  });

  it('gives up after 3 retries on repeated 429', async () => {
    const api = fakeApi([TOO_MANY]);
    const tg = new Telegram(tgCfg, api.deps);
    expect(await tg.send('x')).toBe(false);
    expect(api.fetch).toHaveBeenCalledTimes(4);
    expect(tg.lastError).toMatch(/Too Many Requests/);
  });

  it('returns false on other failures without retrying, and the error never has the token', async () => {
    const api = fakeApi([{ status: 400, body: { ok: false, description: 'Bad Request: chat not found' } }]);
    const tg = new Telegram(tgCfg, api.deps);
    expect(await tg.send('x')).toBe(false);
    expect(api.fetch).toHaveBeenCalledTimes(1);
    expect(tg.lastError).toBe('Bad Request: chat not found');
  });

  it('returns false on a network error and redacts the token', async () => {
    const tg = new Telegram(tgCfg, {
      fetch: (async (url: string) => { throw new Error(`connect failed ${url}`); }) as unknown as typeof fetch,
      sleep: async () => {},
    });
    expect(await tg.send('x')).toBe(false);
    expect(tg.lastError).toMatch(/network error/);
    expect(tg.lastError).not.toContain(TOKEN);
  });

  it('is disabled without enabled, token or chat id, and then never calls fetch', async () => {
    for (const over of [{ enabled: false }, { botToken: '' }, { chatId: '' }]) {
      const api = fakeApi([OK]);
      const tg = new Telegram({ ...tgCfg, ...over }, api.deps);
      expect(tg.enabled).toBe(false);
      expect(await tg.send('x')).toBe(false);
      expect(api.fetch).not.toHaveBeenCalled();
    }
    expect(new Telegram(tgCfg).enabled).toBe(true);
  });
});

describe('Telegram.getChats', () => {
  it('returns unique chats from getUpdates', async () => {
    const api = fakeApi([{
      status: 200,
      body: {
        ok: true,
        result: [
          { update_id: 1, message: { chat: { id: 111, type: 'private', first_name: 'Test', last_name: 'User' } } },
          { update_id: 2, message: { chat: { id: 111, type: 'private', first_name: 'Test', last_name: 'User' } } },
          { update_id: 3, my_chat_member: { chat: { id: -222, type: 'group', title: 'Jobs' } } },
          { update_id: 4, edited_message: { chat: { id: 333, type: 'private', username: 'someone' } } },
          { update_id: 5 },
        ],
      },
    }]);
    const tg = new Telegram({ ...tgCfg, chatId: '' }, api.deps);
    expect(await tg.getChats()).toEqual([
      { id: '111', name: 'Test User', type: 'private' },
      { id: '-222', name: 'Jobs', type: 'group' },
      { id: '333', name: 'someone', type: 'private' },
    ]);
    expect(api.calls[0].url).toMatch(/\/getUpdates$/);
  });

  it('throws a token-free error on failure', async () => {
    const api = fakeApi([{ status: 401, body: { ok: false, description: 'Unauthorized' } }]);
    const tg = new Telegram(tgCfg, api.deps);
    await expect(tg.getChats()).rejects.toThrow('Telegram getUpdates failed: Unauthorized');
  });
});

describe('setChatId', () => {
  it('fills telegram.chatId and keeps comments and other values', async () => {
    const { setChatId } = await import('../src/cli/telegram.js');
    const before = 'telegram:\n  enabled: true\n  botToken: "123:FAKE"   # from @BotFather\n  chatId: ""   # filled by --save\nprofile:\n  firstName: Test\n';
    const after = setChatId(before, '42');
    expect(after).toContain('chatId: "42"');
    expect(after).toContain('# from @BotFather');
    expect(after).toContain('firstName: Test');
  });

  it('changes nothing else in config.example.yaml', async () => {
    const { setChatId } = await import('../src/cli/telegram.js');
    const { default: YAML } = await import('yaml');
    const { default: fs } = await import('node:fs');
    const before = YAML.parse(fs.readFileSync('config.example.yaml', 'utf8'));
    const after = YAML.parse(setChatId(fs.readFileSync('config.example.yaml', 'utf8'), '42'));
    expect(after.telegram.chatId).toBe('42');
    expect({ ...after, telegram: { ...after.telegram, chatId: '' } }).toEqual(before);
  });
});
