import { loadTelegramConfig, SITE_IDS, SITE_NAMES, type Config, type SiteId } from './config.js';
import type { JobRow } from './db.js';
import type { ReasonCode } from './adapters/types.js';
import { clean, sleep } from './utils.js';

const API = 'https://api.telegram.org';
/** Telegram allows ~1 message per second per chat. */
const MIN_GAP_MS = 1100;
const MAX_RETRIES = 3;
/** Don't stall a run for longer than this on one 429. */
const MAX_RETRY_AFTER_S = 60;
/** Telegram allows 4096 visible characters; leave some room. */
const MAX_MESSAGE_CHARS = 3900;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Plain-text version of a message built here (for the console and logs). */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const HEADERS: Partial<Record<JobRow['status'], string>> = {
  company_site: 'Apply on company site',
  needs_review: 'Needs your answers',
  failed: 'Agent could not finish',
};

function failureReason(job: JobRow): string {
  const detail = clean(job.detail);
  const finalClick = job.site === 'wellfound' || job.site === 'workatastartup' ? 'Send' : 'Submit';
  switch (job.reason as ReasonCode | null) {
    case 'NO_CONFIRMATION':
      return `no confirmation after ${finalClick}. It may have gone through; check before re-applying.`;
    case 'FORM_REJECTED':
      return detail ? `the form rejected an answer: ${detail}` : 'the form rejected an answer';
    case 'SELECTOR_MISSING':
      return detail ? `the page layout changed (${detail})` : 'the page layout changed';
    case 'TIMEOUT':
      return 'the page timed out';
    case 'CHECKPOINT':
      return 'stopped at a captcha or verification screen';
    default:
      return detail || 'unexpected error';
  }
}

function metadata(job: JobRow): string {
  const posted = clean(job.posted_at);
  const applicants = clean(job.applicants);
  return [
    clean(job.location),
    clean(job.experience),
    clean(job.salary),
    posted && (/^posted\b/i.test(posted) ? posted : `posted ${posted}`),
    applicants && (/applicant/i.test(applicants) ? applicants : `${applicants} applicants`),
  ].filter(Boolean).join(' · ');
}

/** One hand-off message (company_site / needs_review / failed), HTML, kept under Telegram's 4096-character limit. */
export function formatHandoff(job: JobRow): string {
  const site = SITE_NAMES[job.site] ?? job.site;
  const head = [`${HEADERS[job.status] ?? 'Job update'} · ${site}`];
  const title = cut(clean(job.title) || 'Untitled job', 300);
  const company = cut(clean(job.company), 200);
  head.push(`<b>${escapeHtml(title)}</b>${company ? ` at ${escapeHtml(company)}` : ''}`);
  const meta = cut(metadata(job), 500);
  if (meta) head.push(escapeHtml(meta));

  if (job.status === 'failed') head.push(`Reason: ${escapeHtml(cut(failureReason(job), 500))}`);
  else if (job.status === 'company_site' && job.external_url) head.push(`Apply here: ${escapeHtml(job.external_url)}`);
  const tail = `Job post: ${escapeHtml(job.url)}`;
  if (job.status !== 'needs_review') return [...head, tail].join('\n');

  // Add questions while the visible text stays within the limit; URLs are never cut.
  const questions = (job.detail ?? '').split('\n').map(clean).filter(Boolean);
  const bullets: string[] = [];
  const size = (lines: string[]) => stripHtml(lines.join('\n')).length;
  for (const q of questions) {
    const next = [...head, ...bullets, `• ${escapeHtml(cut(q, 300))}`, '…and 999 more', tail];
    if (size(next) > MAX_MESSAGE_CHARS) break;
    bullets.push(next[next.length - 3]);
  }
  if (bullets.length < questions.length) bullets.push(`…and ${questions.length - bullets.length} more`);
  return [...head, ...bullets, tail].join('\n');
}

export interface SummaryInput {
  header: string;
  applied: Partial<Record<SiteId, number>>;
  sentToYou: number;
  skipped: number;
  failed: number;
  notes: string[];
}

/** Run or day summary, HTML. */
export function formatSummary(s: SummaryInput): string {
  const perSite = SITE_IDS.filter((id) => (s.applied[id] ?? 0) > 0).map((id) => `${SITE_NAMES[id]} ${s.applied[id]}`);
  const total = SITE_IDS.reduce((n, id) => n + (s.applied[id] ?? 0), 0);
  return [
    `<b>${escapeHtml(s.header)}</b>`,
    `Applied ${total}${perSite.length ? ` (${perSite.join(' · ')})` : ''}`,
    `Sent to you ${s.sentToYou} · Skipped ${s.skipped} · Failed ${s.failed}`,
    ...s.notes.map((n) => escapeHtml(clean(n))).filter(Boolean),
  ].join('\n');
}

export interface TelegramDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** The parts of a Bot API response we read. */
interface ApiResponse {
  ok?: boolean;
  description?: string;
  parameters?: { retry_after?: number };
  result?: unknown;
}

interface ApiChat {
  id: number | string;
  type?: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export class Telegram {
  /** Why the last send() failed, without the token. Null after a success. */
  lastError: string | null = null;
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private lastSentAt = -Infinity;

  constructor(private readonly cfg: Config['telegram'], deps: TelegramDeps = {}) {
    this.fetch = deps.fetch ?? globalThis.fetch;
    this.sleep = deps.sleep ?? sleep;
    this.now = deps.now ?? Date.now;
  }

  get enabled(): boolean {
    return Boolean(this.cfg.enabled && this.cfg.botToken && this.cfg.chatId);
  }

  /** Sends one HTML message. True only when Telegram accepted it. Never throws. */
  async send(html: string): Promise<boolean> {
    if (!this.enabled) {
      this.lastError = 'Telegram is disabled or chatId is empty';
      return false;
    }
    const body = {
      chat_id: this.cfg.chatId,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    };
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastSentAt + MIN_GAP_MS - this.now();
      if (wait > 0) await this.sleep(wait);
      const res = await this.call('sendMessage', body);
      this.lastSentAt = this.now();
      if (res.ok) {
        this.lastError = null;
        return true;
      }
      const retryAfter = res.status === 429 ? res.data?.parameters?.retry_after ?? 1 : null;
      if (retryAfter === null || attempt >= MAX_RETRIES || retryAfter > MAX_RETRY_AFTER_S) {
        this.lastError = res.error;
        return false;
      }
      await this.sleep(retryAfter * 1000);
    }
  }

  /** The bot's @username when the token works; throws a token-free error otherwise. */
  async getBotName(): Promise<string> {
    const res = await this.call('getMe', {});
    if (!res.ok) throw new Error(res.status === 0 ? `Could not reach Telegram (${res.error})` : `Telegram rejected the bot token: ${res.error}`);
    // JSON boundary: getMe returns a User object.
    const user = res.data?.result as { username?: string } | undefined;
    return user?.username ? `@${user.username}` : '(unnamed bot)';
  }

  /** Chats that have messaged the bot recently (getUpdates), unique by id. Throws a token-free error on failure. */
  async getChats(): Promise<Array<{ id: string; name: string; type: string }>> {
    const res = await this.call('getUpdates', {});
    if (!res.ok) throw new Error(`Telegram getUpdates failed: ${res.error}`);
    const updates = Array.isArray(res.data?.result) ? res.data.result : [];
    const chats = new Map<string, { id: string; name: string; type: string }>();
    for (const u of updates as Array<Record<string, { chat?: ApiChat } | undefined>>) {
      const chat = (u.message ?? u.edited_message ?? u.channel_post ?? u.my_chat_member)?.chat;
      if (!chat || chat.id === undefined) continue;
      const id = String(chat.id);
      const name = chat.title || clean(`${chat.first_name ?? ''} ${chat.last_name ?? ''}`) || chat.username || '(no name)';
      chats.set(id, { id, name, type: chat.type ?? 'unknown' });
    }
    return [...chats.values()];
  }

  private async call(method: string, body: unknown): Promise<{ ok: boolean; status: number; data: ApiResponse | null; error: string }> {
    try {
      const res = await this.fetch(`${API}/bot${this.cfg.botToken}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      // JSON boundary: the Bot API response shape is only partly typed.
      const data = (await res.json().catch(() => null)) as ApiResponse | null;
      const ok = res.ok && data?.ok === true;
      const error = ok ? '' : this.redact(data?.description || `HTTP ${res.status}`);
      return { ok, status: res.status, data, error };
    } catch (e) {
      // Network errors can carry the request URL (and so the token); redact before anyone sees it.
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, status: 0, data: null, error: this.redact(`network error: ${msg}`) };
    }
  }

  private redact(s: string): string {
    const token = this.cfg.botToken;
    return token ? s.split(token).join('<token>') : s;
  }
}

/** Best-effort alert when a run cannot start (bad config, Chrome won't attach). Never throws. */
export async function sendStartupError(message: string, file?: string): Promise<void> {
  try {
    const tg = new Telegram(loadTelegramConfig(file));
    if (!tg.enabled) return;
    const text = message.split('\n').map(clean).filter(Boolean).join('\n');
    await tg.send(`<b>Job agent could not start</b>\n${escapeHtml(cut(text, 1000))}`);
  } catch {
    // Telegram itself is misconfigured or unreachable: nothing more we can do here.
  }
}
