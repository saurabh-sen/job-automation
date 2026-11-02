import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

export const SITE_IDS = ['linkedin', 'naukri', 'instahyre', 'wellfound', 'workatastartup'] as const;
export type SiteId = (typeof SITE_IDS)[number];

export const SITE_NAMES: Record<SiteId, string> = {
  linkedin: 'LinkedIn',
  naukri: 'Naukri',
  instahyre: 'Instahyre',
  wellfound: 'Wellfound',
  workatastartup: 'Work at a Startup',
};

export const DEFAULT_DISCOVERY: Record<SiteId, string[]> = {
  linkedin: ['https://www.linkedin.com/jobs/collections/recommended/'],
  naukri: ['https://www.naukri.com/mnjuser/recommendedjobs'],
  instahyre: ['https://www.instahyre.com/candidate/opportunities/'],
  wellfound: ['https://wellfound.com/jobs'],
  workatastartup: ['https://www.workatastartup.com/companies'],
};

export const DEFAULT_SCHEDULE_TIMES = ['08:00', '11:30', '15:00', '20:00'];

const str = z.string().trim();
const nonEmpty = str.min(1, 'is empty');
/** Phone numbers and codes are often written unquoted in YAML, which parses them as numbers. */
const digits = z.union([z.string(), z.number()]).transform((v) => String(v).trim());
const range = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
  .refine(([a, b]) => a <= b, 'must be [min, max]');
const site = (id: SiteId) =>
  z.object({
    enabled: z.boolean().default(false),
    /** Real submissions happen only when true. Set it when the user says "go live for <site>". */
    live: z.boolean().default(false),
    discoveryUrls: z.array(z.string().url()).default(DEFAULT_DISCOVERY[id]),
  }).strict().default({});

const schema = z.object({
  chrome: z.object({
    cdpUrl: z.string().url().default('http://127.0.0.1:9333'),
    /** Empty means auto-detect (see src/platform.ts). */
    executablePath: str.default(''),
    userDataDir: nonEmpty.default('~/job-agent-chrome'),
  }).strict().default({}),

  telegram: z.object({
    enabled: z.boolean().default(true),
    botToken: str.default(''),
    chatId: z.union([str, z.number()]).transform(String).default(''),
    /** First run at or after this local time sends the whole-day summary (once per day). */
    dailySummaryAfter: z.string().regex(/^\d{2}:\d{2}$/, 'must be HH:MM').default('19:30'),
  }).strict().default({}),

  ollama: z.object({
    enabled: z.boolean().default(false),
    url: z.string().url().default('http://127.0.0.1:11434'),
    model: nonEmpty.default('llama3.1:8b'),
  }).strict().default({}),

  profile: z.object({
    firstName: nonEmpty,
    lastName: nonEmpty,
    email: z.string().trim().email(),
    countryCode: digits.default('+91'),
    phone: digits.refine((s) => s.length > 0, 'is empty'),
    city: nonEmpty,
    currentCompany: nonEmpty,
    currentTitle: nonEmpty,
    /** Earlier employers, for "were you previously employed with X?" (the current company counts too). */
    previousEmployers: z.array(nonEmpty).default([]),
    totalExperienceYears: z.number().positive(),
    skillYears: z.record(z.number().nonnegative()),
    noticePeriodDays: z.number().int().nonnegative(),
    currentCtcLpa: z.number().positive(),
    expectedCtcLpa: z.number().positive(),
    willingToRelocate: z.boolean(),
    okWithOnsite: z.boolean(),
    linkedinUrl: str.default(''),
    githubUrl: str.default(''),
    portfolioUrl: str.default(''),
    highestDegree: nonEmpty,
    /** Accepted names in order of preference, e.g. ["Computer Science", "Computer and Information Science"]; empty means ask. */
    fieldOfStudy: z.union([str, z.array(nonEmpty)]).transform((v) => (Array.isArray(v) ? v : v ? [v] : [])).default([]),
    graduationYear: z.number().int(),
    /** Only used by the optional Ollama answerer. */
    summary: str.default(''),
  }).strict(),

  customAnswers: z.array(z.object({
    match: nonEmpty.refine((s) => { try { new RegExp(s, 'i'); return true; } catch { return false; } }, 'is not a valid regex'),
    answer: nonEmpty,
  }).strict()).default([]),

  /** Written by each user about themselves; required only for the sites that use them. */
  templates: z.object({
    workatastartup: str.default(''),
    wellfound: str.default(''),
  }).strict().default({}),

  filters: z.object({
    includeTitleKeywords: z.array(nonEmpty).min(1),
    excludeTitleKeywords: z.array(nonEmpty).default([]),
    excludeCompanies: z.array(nonEmpty).default([]),
    locations: z.array(nonEmpty).default([]),
    /** Skip a job only when its minimum required years is above this. */
    maxRequiredExperience: z.number().nonnegative().default(5),
  }).strict(),

  limits: z.object({
    dailyCap: z.object({
      linkedin: z.number().int().nonnegative().default(15),
      naukri: z.number().int().nonnegative().default(25),
      instahyre: z.number().int().nonnegative().default(30),
      wellfound: z.number().int().nonnegative().default(15),
      workatastartup: z.number().int().nonnegative().default(10),
    }).strict().default({}),
    maxJobsToScanPerSite: z.number().int().positive().default(60),
    delayBetweenAppliesMs: range.default([20000, 60000]),
    actionDelayMs: range.default([500, 2000]),
    parallelSites: z.boolean().default(false),
  }).strict().default({}),

  schedule: z.object({
    times: z.array(z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'must be HH:MM (24-hour)')).min(1).default(DEFAULT_SCHEDULE_TIMES),
  }).strict().default({}),

  sites: z.object({
    linkedin: site('linkedin'),
    naukri: site('naukri'),
    instahyre: site('instahyre'),
    wellfound: site('wellfound'),
    workatastartup: site('workatastartup'),
  }).strict().default({}),
}).strict();

export type Config = z.infer<typeof schema>;
export type Profile = Config['profile'];

export class ConfigError extends Error {
  constructor(public problems: string[]) {
    super(`config.yaml has problems:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}

/** Matches placeholder values such as "TODO" or "TODO@gmail.com". */
export const isTodo = (v: unknown) => typeof v === 'string' && /\bTODO\b/i.test(v);

function todoPaths(v: unknown, at: string[] = []): string[] {
  if (isTodo(v)) return [at.join('.')];
  if (Array.isArray(v)) return v.flatMap((x, i) => todoPaths(x, [...at, String(i)]));
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => todoPaths(x, [...at, k]));
  return [];
}

const expandHome = (p: string) => p.replace(/^~(?=$|[\\/])/, os.homedir());

/** Validates a parsed config object. Throws ConfigError listing every problem (TODOs, missing or invalid fields). */
export function parseConfig(raw: unknown): Config {
  const problems = todoPaths(raw).map((p) => `${p} is still TODO`);
  const res = schema.safeParse(raw ?? {});
  if (!res.success) {
    for (const i of res.error.issues) {
      const where = i.path.join('.') || '(root)';
      if (!problems.some((p) => p.startsWith(`${where} `))) problems.push(`${where}: ${i.message}`);
    }
  }
  if (res.success) {
    const t = res.data.telegram;
    if (t.enabled && !t.botToken) problems.push('telegram.botToken is missing (or set telegram.enabled: false)');
    if (t.enabled && !t.chatId) problems.push('telegram.chatId is missing. Message your bot, then run `npm run telegram -- --save` to fill it in.');
    for (const id of ['wellfound', 'workatastartup'] as const) {
      // live counts too: `--site=<id>` runs a disabled site
      if ((res.data.sites[id].enabled || res.data.sites[id].live) && !res.data.templates[id]) {
        problems.push(`templates.${id} is missing: write the short message sent with each ${SITE_NAMES[id]} application (or disable sites.${id})`);
      }
    }
  }
  if (problems.length || !res.success) throw new ConfigError(problems);
  const cfg = res.data;
  cfg.chrome.userDataDir = expandHome(cfg.chrome.userDataDir);
  return cfg;
}

export function readRawConfig(file = 'config.yaml'): unknown {
  const full = path.resolve(file);
  if (!fs.existsSync(full)) {
    throw new ConfigError(['config.yaml not found. Copy config.example.yaml to config.yaml and fill it in.']);
  }
  return YAML.parse(fs.readFileSync(full, 'utf8'));
}

/** Full, validated config. Refuses to run with TODO values or missing Telegram settings. */
export function loadConfig(file = 'config.yaml'): Config {
  return parseConfig(readRawConfig(file));
}

/** Just the chrome section (for `npm run chrome` / `inspect`, which must work before the profile is filled). */
export function loadChromeConfig(file = 'config.yaml'): Config['chrome'] {
  const raw = readRawConfig(file) as { chrome?: unknown } | null;
  const res = schema.shape.chrome.safeParse(raw?.chrome);
  if (!res.success) throw new ConfigError(res.error.issues.map((i) => `chrome.${i.path.join('.')}: ${i.message}`));
  return { ...res.data, userDataDir: expandHome(res.data.userDataDir) };
}

/** Just the schedule section (for `npm run schedule:*`, which must work before the profile is filled). */
export function loadScheduleConfig(file = 'config.yaml'): Config['schedule'] {
  const raw = fs.existsSync(path.resolve(file)) ? (readRawConfig(file) as { schedule?: unknown } | null) : null;
  const res = schema.shape.schedule.safeParse(raw?.schedule);
  if (!res.success) throw new ConfigError(res.error.issues.map((i) => `schedule.${i.path.join('.')}: ${i.message}`));
  return res.data;
}

/** Just the telegram section; chatId may still be empty (`npm run telegram` finds it). */
export function loadTelegramConfig(file = 'config.yaml'): Config['telegram'] {
  const raw = readRawConfig(file) as { telegram?: unknown } | null;
  const res = schema.shape.telegram.safeParse(raw?.telegram);
  if (!res.success) throw new ConfigError(res.error.issues.map((i) => `telegram.${i.path.join('.')}: ${i.message}`));
  if (!res.data.botToken || isTodo(res.data.botToken)) throw new ConfigError(['telegram.botToken is missing']);
  return res.data;
}
