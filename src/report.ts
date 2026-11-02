import fs from 'node:fs';
import path from 'node:path';
import { SITE_IDS, SITE_NAMES } from './config.js';
import { HANDOFF_STATUSES, type JobDb, type JobRow } from './db.js';
import { clean, localDate } from './utils.js';

const REASON_TEXT: Record<string, string> = {
  NO_CONFIRMATION: 'no confirmation after Submit; check before re-applying',
  FORM_REJECTED: 'the form rejected an answer',
  SELECTOR_MISSING: 'the page layout changed',
  TIMEOUT: 'the page timed out',
  CHECKPOINT: 'stopped at a captcha or verification screen',
  UNANSWERED_QUESTIONS: 'needs your answers',
  COMPANY_SITE: 'apply on the company site',
  UNKNOWN: 'unexpected error',
};

/**
 * Groups skip reasons that differ only in their specifics: numbers become N, quoted and bracketed parts become "…",
 * and anything after ": " is dropped. So "needs 6+ yrs" and "needs 7+ yrs" share the key "needs N+ yrs".
 */
export function skipGroup(reason: string | null | undefined): { key: string; value?: string } {
  let rest = clean(reason);
  if (!rest) return { key: 'other' };
  const values: string[] = [];
  const colon = rest.match(/^(.+?):\s+(.+)$/);
  if (colon) {
    rest = colon[1];
    values.push(colon[2]);
  }
  const key = rest
    .replace(/"([^"]*)"/g, (_, v: string) => (values.push(v), '"…"'))
    .replace(/\(([^)]*)\)/g, (_, v: string) => (values.push(v), '(…)'))
    .replace(/\d+(?:\.\d+)?/g, (v) => (values.push(v), 'N'));
  return values.length ? { key, value: values.join(' ') } : { key };
}

const linkText = (s: string) => s.replace(/[[\]]/g, (c) => (c === '[' ? '(' : ')'));

function jobLink(r: JobRow, withSite = true) {
  const parts = [`[${linkText(r.title || r.job_id)}](${r.url})`, r.company || '?'];
  if (withSite) parts.push(SITE_NAMES[r.site] ?? r.site);
  return `- ${parts.join(' · ')}`;
}

function reasonText(r: JobRow) {
  const human = r.reason ? (REASON_TEXT[r.reason] ?? r.reason) : '';
  const detail = clean(r.detail);
  if (human && detail) return `${human} (${detail})`;
  return human || detail || 'no reason recorded';
}

const counted = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

/** The daily markdown report. */
export function buildReport(date: string, rows: JobRow[], notes: string[], pendingCount: number): string {
  const of = (s: JobRow['status']) => rows.filter((r) => r.status === s);
  const applied = of('applied');
  const skipped = of('skipped');
  const sentToYou = rows.filter((r) => HANDOFF_STATUSES.includes(r.status));
  const out: string[] = [
    `# Job agent report · ${date}`,
    '',
    `Applied ${applied.length} · Sent to you ${sentToYou.length} · Skipped ${skipped.length} · ` +
      `Failed ${of('failed').length} · Already applied ${of('already_applied').length}`,
    '',
  ];

  if (notes.length) out.push('## Run notes', '', ...notes.map((n) => `- ${n}`), '');

  out.push('## Applied', '');
  if (!applied.length) out.push('None yet.', '');
  for (const site of SITE_IDS) {
    const list = applied.filter((r) => r.site === site);
    if (list.length) out.push(`### ${SITE_NAMES[site]} (${list.length})`, '', ...list.map((r) => jobLink(r, false)), '');
  }

  out.push('## Sent to you', '');
  if (!sentToYou.length) out.push('Nothing today.', '');
  const companySite = of('company_site');
  if (companySite.length) {
    out.push(`### Apply on company site (${companySite.length})`, '');
    for (const r of companySite) out.push(jobLink(r) + (r.external_url ? ` · [apply here](${r.external_url})` : ''));
    out.push('');
  }
  const review = of('needs_review');
  if (review.length) {
    out.push(`### Needs your answers (${review.length})`, '');
    for (const r of review) {
      out.push(jobLink(r));
      const questions = (r.detail ?? '').split('\n').map(clean).filter(Boolean);
      out.push(...(questions.length ? questions.map((q) => `  - ${q}`) : [`  - ${reasonText(r)}`]));
    }
    out.push('');
  }
  const failed = of('failed');
  if (failed.length) {
    out.push(`### Could not finish (${failed.length})`, '');
    for (const r of failed) out.push(`${jobLink(r)}: ${reasonText(r)}`);
    out.push('');
  }
  if (skipped.length) {
    const groups = new Map<string, { n: number; values: Map<string, number> }>();
    for (const r of skipped) {
      const { key, value } = skipGroup(r.reason);
      const g = groups.get(key) ?? { n: 0, values: new Map<string, number>() };
      g.n += 1;
      if (value) counted(g.values, value);
      groups.set(key, g);
    }
    out.push(`## Skipped by reason (${skipped.length})`, '');
    for (const [key, g] of [...groups].sort((a, b) => b[1].n - a[1].n)) {
      const vals = [...g.values].sort((a, b) => b[1] - a[1]);
      const shown = vals.slice(0, 5).map(([v, n]) => (n > 1 ? `${v} ×${n}` : v));
      if (vals.length > 5) shown.push(`${vals.length - 5} more`);
      out.push(`- ${key}: ${g.n}${shown.length ? ` (${shown.join(', ')})` : ''}`);
    }
    out.push('');
  }

  if (pendingCount > 0) {
    out.push(`${pendingCount} question(s) waiting for your answer. Run \`npm run review\`; answers are reused for future jobs (jobs already sent to Telegram are yours to finish).`, '');
  }

  return out.join('\n');
}

/** Writes reports/<date>.md covering the whole day so far. Returns the file path. */
export function writeReport(db: JobDb, date = localDate(), dir = 'reports'): string {
  const md = buildReport(date, db.jobsOn(date), db.notesOn(date), db.listPending().length);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.resolve(dir, `${date}.md`);
  fs.writeFileSync(file, md);
  return file;
}
