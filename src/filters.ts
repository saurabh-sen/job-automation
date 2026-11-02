import type { Config } from './config.js';

export type FilterResult = { ok: true } | { ok: false; reason: string };

export interface FilterJob {
  title: string;
  company: string;
  location: string;
  description: string;
  experience?: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-word/phrase match. Spaces or hyphens inside the keyword match any run of spaces/hyphens/dashes (or none). */
function hasKeyword(lowerTitle: string, kw: string): boolean {
  const parts = kw.toLowerCase().trim().split(/[\s\-–—]+/).filter(Boolean).map(escapeRe);
  if (!parts.length) return false;
  return new RegExp(`(?<![a-z0-9])${parts.join('[\\s\\-–—]*')}(?![a-z0-9])`).test(lowerTitle);
}

/** Relevance rules from SPEC §8. Returns the first failing rule as a short, human-readable reason. */
export function checkFilters(job: FilterJob, f: Config['filters']): FilterResult {
  const skip = (reason: string): FilterResult => ({ ok: false, reason });
  const rawTitle = (job.title ?? '').trim();
  if (!rawTitle) return skip('could not read the job title');
  const title = rawTitle.toLowerCase().replace(/\s+/g, ' ');
  const company = (job.company ?? '').toLowerCase();

  const badCompany = company ? f.excludeCompanies.find((c) => company.includes(c.toLowerCase().trim())) : undefined;
  if (badCompany) return skip(`excluded company (${badCompany})`);

  const badKw = f.excludeTitleKeywords.find((k) => hasKeyword(title, k));
  if (badKw) return skip(`title has "${badKw}"`);

  if (!f.includeTitleKeywords.some((k) => title.includes(k.toLowerCase().trim()))) return skip('not a target role');

  const min = minExperience(job.experience ?? '') ?? minExperience(job.description ?? '');
  if (min !== null && min > f.maxRequiredExperience) return skip(`needs ${min}+ yrs`);

  const location = (job.location ?? '').trim();
  const loc = location.toLowerCase();
  if (f.locations.length && loc && !isRemote(loc) && !f.locations.some((l) => loc.includes(l.toLowerCase().trim()))) {
    return skip(`location: ${location.split('\n')[0].trim().slice(0, 60)}`);
  }
  // SPEC §7.5: roles that need US work authorization (or won't sponsor) are skipped unless the location is open to India
  const text = `${location}\n${job.description ?? ''}`;
  if (US_ONLY.test(text) && !INDIA_OK.test(loc)) return skip('needs US work authorization');
  return { ok: true };
}

const US_ONLY = /\b(?:us|u\.s\.) citizens?(?:hip)?\b|authori[sz]ed to work in the (?:us|u\.s\.|united states)|\b(?:us|u\.s\.) work authori[sz]ation|\b(?:no|not|unable to|will not|won't|cannot|can't|does not|doesn't) (?:provide |offer )?(?:visa )?sponsor|visa sponsorship:\s*(?:not available|no)\b/i;
const INDIA_OK = /\bindia\b|hyderabad|bengaluru|bangalore|pune|chennai|mumbai|delhi|noida|gurgaon|gurugram|worldwide|anywhere|global/i;

// Building blocks for minExperience. Text is lowercased and dashes/apostrophes normalised first.
const NUM = String.raw`(?<![\d.])(\d{1,2}(?:\.\d+)?)(?!\.?\d)`;
/** Not the second half of a range ("3-6", "3 to 6"). */
const NOT_RANGE_END = String.raw`(?<!\d\s*(?:-|to)\s*)`;
const UNIT = String.raw`(?:years?(?:\(s\))?(?![a-z])|yrs?(?![a-z])\.?)`; // only the abbreviation may carry a dot
const NOT_AGO = String.raw`(?!\s+(?:ago|old)\b)`;
const EXP_WORD = String.raw`\bexp(?:erience[sd]?)?\b`;
const SEP = String.raw`[^\w.\n]+`; // separators between words; never crosses a sentence end
const WORDS_UP_TO = (n: number) => String.raw`(?:${SEP}[a-z][a-z'\-]*){0,${n}}?`;

const EXPERIENCE_PATTERNS: RegExp[] = [
  // "3-6 yrs", "3 - 6 years", "3 to 6 years", "0-2 yrs"
  new RegExp(String.raw`${NUM}\s*(?:-|to)\s*\d{1,2}(?:\.\d+)?\s*\+?\s*${UNIT}${NOT_AGO}`, 'gd'),
  // "5+ years", "5+ yrs", "5 + years"
  new RegExp(String.raw`${NOT_RANGE_END}${NUM}\s*\+\s*${UNIT}${NOT_AGO}`, 'gd'),
  // "minimum 4 years", "min. 4 yrs", "at least 4 years", "minimum of 4+ years"
  new RegExp(String.raw`\b(?:minimum|min\.?|at\s*least)\s*(?:of\s+)?${NUM}\s*\+?\s*${UNIT}${NOT_AGO}`, 'gd'),
  // "4 years of experience", "4+ years' experience", "3 yrs exp", "4 years of hands-on experience"
  new RegExp(String.raw`${NOT_RANGE_END}${NUM}\s*\+?\s*${UNIT}${NOT_AGO}${WORDS_UP_TO(4)}${SEP}${EXP_WORD}`, 'gd'),
  // "experience of 3 years", "experience: 4+ years", "experience required: 3 yrs"
  new RegExp(String.raw`${EXP_WORD}${WORDS_UP_TO(3)}${SEP}${NOT_RANGE_END}${NUM}\s*\+?\s*${UNIT}${NOT_AGO}`, 'gd'),
  // "between 3 and 5 years", "3 years to 5 years", "2 yrs - 4 yrs" (the earlier lower bound wins over the upper one)
  new RegExp(String.raw`\bbetween\s+${NUM}\s*(?:${UNIT})?\s*(?:and|-|to)\s*\d{1,2}(?:\.\d+)?\s*\+?\s*${UNIT}${NOT_AGO}`, 'gd'),
  new RegExp(String.raw`${NUM}\s*${UNIT}\s*(?:-|to)\s*\d{1,2}(?:\.\d+)?\s*\+?\s*${UNIT}${NOT_AGO}`, 'gd'),
  // "3 or more years", "3 yrs+"
  new RegExp(String.raw`${NOT_RANGE_END}${NUM}\s*or\s+more\s+${UNIT}${NOT_AGO}`, 'gd'),
  new RegExp(String.raw`${NOT_RANGE_END}${NUM}\s*${UNIT}\s*\+`, 'gd'),
  // "experience: 3+", "experience: 3-5", "exp 2 to 4" (no unit, so the number must follow the word directly)
  new RegExp(String.raw`${EXP_WORD}\s*[:\-(.]?\s*${NUM}\s*(?:\+|(?:-|to)\s*\d)`, 'gd'),
];
const MONTHS_TO_YEARS = new RegExp(String.raw`(?<![\d.])(\d{1,2})\s*months?\s*(?:-|to)\s*\d{1,2}(?:\.\d+)?\s*\+?\s*${UNIT}`, 'g');
/** "Fresher" means 0 years, but not when negated: "no freshers", "not open to freshers", "freshers need not apply". */
const FRESHER =
  /(?<!(?:\b(?:no|not|non|cannot)|n't)(?:[\s-]+[a-z']+){0,3}[\s-]+)\bfreshers?\b(?!\s+(?:(?:are|is|need|should|can|do|will)\s+not|needn't|shouldn't|can't|cannot|don't|won't|not)\b)/gd;
/** A whole field that is just a range or one number with a unit, like Naukri's "0-2" chip or "5 Yrs". */
const BARE_RANGE = new RegExp(
  String.raw`^(?:exp(?:erience)?\s*:?\s*)?${NUM}(?:\s*(?:-|to)\s*\d{1,2}(?:\.\d+)?\s*\+?\s*(?:${UNIT})?|\s*\+?\s*${UNIT}|\s*\+)$`,
);

/**
 * Minimum years of experience asked for, from the first experience mention in text order.
 * "3-6 Yrs" -> 3, "5+ years of experience" -> 5, "Fresher" -> 0. Numbers not tied to experience are ignored.
 */
export function minExperience(text: string): number | null {
  if (!text) return null;
  const t = text
    .toLowerCase()
    .replace(/[–—‐‑−]/g, '-')
    .replace(/[’‘`]/g, "'");
  const bare = t.trim().match(BARE_RANGE);
  if (bare) return Number(bare[1]);

  let bestAt = Infinity;
  let best: number | null = null;
  const consider = (at: number, value: number) => {
    if (Number.isFinite(value) && at < bestAt) [bestAt, best] = [at, value];
  };
  for (const re of EXPERIENCE_PATTERNS) {
    for (const m of t.matchAll(re)) {
      const span = m.indices?.[1];
      if (span) consider(span[0], Number(m[1]));
    }
  }
  // "6 months to 2 years" -> 0.5
  for (const m of t.matchAll(MONTHS_TO_YEARS)) consider(m.index ?? 0, Number(m[1]) / 12);
  for (const m of t.matchAll(FRESHER)) consider(m.index ?? 0, 0);
  return best;
}

export function isRemote(location: string): boolean {
  return /\bremote\b|\banywhere\b|work from home|\bwfh\b/i.test(location);
}

const TITLE_SYNONYMS: Array<[RegExp, string]> = [
  [/\bfront end\b/g, 'frontend'],
  [/\bfull stack\b/g, 'fullstack'],
  [/\bback end\b/g, 'backend'],
  [/\bsr\b/g, 'senior'],
  [/\bjr\b/g, 'junior'],
  [/\bdev\b/g, 'developer'],
];

/** Comparable job title: "Sr. Front-End Dev (React) - Remote" -> "senior frontend developer". */
export function normalizeTitle(t: string): string {
  let s = (t ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .split(/\s[-–—|]\s|,/)[0]
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [re, to] of TITLE_SYNONYMS) s = s.replace(re, to);
  return s;
}

const COMPANY_SUFFIXES = new Set(['pvt', 'private', 'ltd', 'limited', 'inc', 'llc', 'llp', 'corp', 'corporation', 'co']);

/** Comparable company name: lowercase, no punctuation, trailing legal suffixes dropped ("Acme Pvt. Ltd." -> "acme"). */
export function normalizeCompany(c: string): string {
  const words = (c ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  let stripped = false;
  while (words.length > 1 && COMPANY_SUFFIXES.has(words[words.length - 1])) {
    words.pop();
    stripped = true;
  }
  // "Acme India Pvt Ltd" is the same employer as "Acme".
  if (stripped && words.length > 1 && words[words.length - 1] === 'india') words.pop();
  return words.join(' ');
}
