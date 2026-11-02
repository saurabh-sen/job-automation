import { isTodo, type Config, type Profile } from './config.js';
import { askJson } from './llm.js';

export type FieldKind = 'text' | 'number' | 'textarea' | 'select' | 'radio' | 'checkbox';

export interface Question {
  label: string;
  kind: FieldKind;
  options?: string[];
}

/** Where saved answers and the review queue live. JobDb satisfies this structurally. */
export interface AnswerStore {
  getAnswer(q: string): string | null;
  saveAnswer(q: string, a: string, source: 'you' | 'llm'): void;
  addPending(q: string, kind: string, options: string[], jobUrl: string): void;
}

/** Returns the parsed JSON reply, or null when the model is off/unavailable. */
export type LlmFn = (system: string, user: string) => Promise<unknown | null>;

const usable = (v: string | null | undefined): v is string => v != null && v.trim() !== '' && !isTodo(v);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const num = (s: string) => Number(s.replace(/,/g, ''));

/** Maps a raw answer onto one of the offered options (returning the option string as given), or null if none fits. */
export function matchOption(answer: string, options: string[]): string | null {
  const a = answer.trim().toLowerCase();
  if (!a) return null;
  const opts = options.filter((o) => o && o.trim());
  const low = (o: string) => o.trim().toLowerCase();

  const exact = opts.find((o) => low(o) === a);
  if (exact) return exact;

  // the prefix must end on a word boundary: "Yes" picks "Yes, I am" but "No" never picks "None";
  // a bare number must match a whole token: "1" never picks "15 days" or "1.5 years", but may pick "1 year"
  const numeric = /^\d+(\.\d+)?$/.test(a);
  const prefix = opts.find((o) => {
    const l = low(o);
    if (!l.startsWith(a) || l.length === a.length) return l === a;
    const next = l[a.length];
    if (numeric && /[\d.,]/.test(next)) return false;
    return !/[a-z0-9]/.test(a[a.length - 1]) || !/[a-z0-9]/.test(next);
  });
  if (prefix) return prefix;

  if (a.length > 2 && !numeric) {
    const word = new RegExp(`(?<![a-z0-9])${escapeRe(a)}(?![a-z0-9])`);
    const contains = opts.find((o) => word.test(low(o)));
    if (contains) return contains;
  }

  if (!numeric) return null;
  const n = Number(a);
  const N = String.raw`(\d+(?:[.,]\d+)?)`;
  if (n === 0) {
    const immediate = opts.find((o) => /immediate/i.test(o));
    if (immediate) return immediate;
  }
  for (const o of opts) {
    const m = low(o).match(new RegExp(`${N}\\s*(?:-|–|—|to)\\s*${N}`));
    if (m && n >= num(m[1]) && n <= num(m[2])) return o;
  }
  for (const o of opts) {
    const m = low(o).match(new RegExp(`${N}\\s*\\+|${N}\\s*(?:\\w+\\s*)?(?:or more|and above|and more)`));
    if (m && n >= num(m[1] ?? m[2])) return o;
  }
  for (const o of opts) {
    const l = low(o);
    const lt = l.match(new RegExp(`(?:less than|under|below|<)\\s*${N}`));
    if (lt && n < num(lt[1])) return o;
    const le = l.match(new RegExp(`(?:up\\s?to|within|<=|≤)\\s*${N}|${N}\\s*(?:\\w+\\s*)?or less`));
    if (le && n <= num(le[1] ?? le[2])) return o;
    const gt = l.match(new RegExp(`(?:more than|over|above|greater than|>)\\s*${N}`));
    if (gt && n > num(gt[1])) return o;
  }
  return null;
}

/** Common spellings of skill names, mapped to a canonical lowercase key. */
const SKILL_ALIASES: Record<string, string> = {
  reactjs: 'react', 'react.js': 'react', 'react js': 'react',
  node: 'node.js', nodejs: 'node.js', 'node js': 'node.js',
  js: 'javascript', ts: 'typescript',
  angularjs: 'angular', 'angular.js': 'angular', 'angular js': 'angular',
  vuejs: 'vue', 'vue.js': 'vue', nextjs: 'next.js', 'next js': 'next.js',
};
const canonical = (s: string) => SKILL_ALIASES[s.trim().toLowerCase()] ?? s.trim().toLowerCase();

/** Years for the first profile skill named in the text, or undefined if none is named. */
function skillIn(t: string, skillYears: Record<string, number>): { name: string; years: number } | undefined {
  const variants: Array<{ v: string; name: string }> = [];
  for (const name of Object.keys(skillYears)) {
    const c = canonical(name);
    variants.push({ v: name.toLowerCase(), name }, { v: c, name });
    for (const [alias, to] of Object.entries(SKILL_ALIASES)) if (to === c) variants.push({ v: alias, name });
  }
  variants.sort((x, y) => y.v.length - x.v.length);
  for (const { v, name } of variants) {
    const after = v === 'react' ? String.raw`(?![a-z0-9])(?!\s*native)` : '(?![a-z0-9])';
    // "." in the lookbehind keeps the "js" alias from matching "Express.js" or "Vue.js"
    if (new RegExp(`(?<![a-z0-9.])${escapeRe(v)}${after}`).test(t)) return { name, years: skillYears[name] };
  }
  return undefined;
}

/** Phrases after "experience in/with ..." that mean overall experience, not a specific skill. */
const GENERIC_EXP = /^(the |this )?(years?|months?|total|overall|work|professional|relevant|industry|it|software|tech(nology)?|full[- ]time|(it|software|tech) industry|software (development|engineering)|(this |the )?(role|field|domain|position))\b[\s\w]*$/;

type Candidates = string | string[] | null;

/** Degree level: 3 doctorate, 2 master's, 1 bachelor's. */
function degreeLevel(s: string): number | null {
  const t = s.toLowerCase();
  if (/\bph\.?\s?d\b|doctor/.test(t)) return 3;
  if (/master|\bm\.?\s?(tech|e|sc|s|ca|ba)\b|\bmba\b|post[- ]?grad/.test(t)) return 2;
  if (/bachelor|\bb\.?\s?(tech|e|sc|s|ca|com|a)\b|graduat|\bdegree\b|\bbe\b/.test(t)) return 1;
  return null;
}
/** Short degree names -> the long form degree dropdowns use. */
const DEGREE_NAMES: Record<string, string[]> = {
  btech: ['Bachelor of Technology'], be: ['Bachelor of Engineering'], bsc: ['Bachelor of Science'], bca: ['Bachelor of Computer Applications'],
  mtech: ['Master of Technology'], me: ['Master of Engineering'], msc: ['Master of Science'], mca: ['Master of Computer Applications'],
};
const DEGREE_WORDS: Record<number, string[]> = { 1: ['Bachelor', 'Graduate', 'B.Tech', 'B.E'], 2: ['Master', 'Post Graduate'], 3: ['PhD', 'Doctorate'] };

/** Option label -> [minDays, maxDays] for notice-period options. */
function noticeRange(option: string): [number, number] | null {
  const o = option.toLowerCase();
  if (/immediate|^0\s*days?$|serving/.test(o)) return /serving/.test(o) ? null : [0, 0];
  const unit = (s: string | undefined) => (s && /month/.test(s) ? 30 : s && /week/.test(s) ? 7 : 1);
  const unitWord = String.raw`\s*(days?|weeks?|months?)?`;
  let m = o.match(new RegExp(String.raw`(\d+)\s*(?:-|–|to)\s*(\d+)${unitWord}`));
  if (m) return [Number(m[1]) * unit(m[3]), Number(m[2]) * unit(m[3])];
  m = o.match(new RegExp(String.raw`(?:more than|over|above|beyond|>)\s*(\d+)${unitWord}`)) ??
    o.match(new RegExp(String.raw`(\d+)\+${unitWord}`));
  if (m) return [Number(m[1]) * unit(m[2]) + 1, Infinity];
  m = o.match(new RegExp(String.raw`(?:less than|up\s?to|within|under|<)\s*(\d+)${unitWord}`)) ??
    o.match(new RegExp(String.raw`(\d+)${unitWord}\s*or less`));
  if (m) return [0, Number(m[1]) * unit(m[2])];
  m = o.match(new RegExp(String.raw`(\d+)${unitWord}`));
  if (m) return [Number(m[1]) * unit(m[2]), Number(m[1]) * unit(m[2])];
  return null;
}

function noticeAnswer(days: number, t: string, options: string[]): Candidates {
  if (options.length) {
    const ranged = options.map((o) => ({ o, r: noticeRange(o) })).filter((x) => x.r) as Array<{ o: string; r: [number, number] }>;
    const inside = ranged.find((x) => days >= x.r[0] && days <= x.r[1]);
    if (inside) return inside.o;
    // otherwise the shortest option that still covers the notice period (never claim a shorter one)
    const above = ranged.filter((x) => x.r[1] >= days).sort((x, y) => x.r[1] - y.r[1])[0];
    if (above) return above.o;
  }
  const inMonths = /\bmonths?\b/.test(t) || options.some((o) => /month/i.test(o));
  if (inMonths) return days === 0 ? ['Immediate', '0'] : String(Math.round((days / 30) * 10) / 10);
  return days === 0 ? ['0', 'Immediate'] : String(days);
}

/** Years for every skill named in "with/in/using/on <skills>", or null if any of them isn't in the profile. */
function namedSkillYears(t: string, skillYears: Record<string, number>): number | null | undefined {
  const phrase = t.match(/\b(?:with|in|using|on)\s+([^?*:()]+)/)?.[1]?.trim() ??
    t.match(/\byears? of ([a-z0-9.#+/ -]+?) (?:work )?experience\b/)?.[1]?.trim();
  if (!phrase || GENERIC_EXP.test(phrase)) {
    const skill = skillIn(t, skillYears);
    return skill ? skill.years : undefined; // undefined: no skill named
  }
  const parts = phrase.split(/\s*(?:,|&|\/|\band\b|\bor\b)\s*/).filter((s) => s && !GENERIC_EXP.test(s));
  const years = parts.map((part) => skillIn(part, skillYears)?.years);
  if (!years.length || years.some((y) => y == null)) return null;
  return Math.min(...(years as number[]));
}

const INDIA_PLACE = /\bindia\b|hyderabad|bengaluru|bangalore|pune|chennai|mumbai|delhi|noida|gurgaon|gurugram|kolkata|telangana|karnataka|maharashtra/i;

/** "authorized to work in Japan" names a country other than India. */
const namesOtherCountry = (t: string) => {
  if (/\bindia\b/.test(t)) return false;
  return /\b(united states|usa|u\.s\.?|us|uk|united kingdom|canada|europe|eu|germany|australia|singapore|uae|dubai|netherlands|ireland)\b/.test(t) ||
    /\b(?:work|employment|employed|sponsorship|visa)\b[^?]*\b(?:in|for)\s+(?:the\s+)?[a-z]{3,}/.test(t);
};

/** "Globex Systems Limited" -> "globex systems", "acme.ai" -> "acme". */
const normCompany = (c: string) => c.toLowerCase().replace(/\.(ai|io|com|in|co)\b/g, '').replace(/[^a-z0-9& ]+/g, ' ')
  .replace(/\b(pvt|private|ltd|limited|inc|llc|llp|corp|corporation|technologies|india)\b/g, ' ').replace(/\s+/g, ' ').trim();

/** Short, field-style labels ("Mobile number", "Email") as opposed to questions that merely mention the word. */
const fieldLike = (t: string) => t.length <= 60 && !/\b(why|how|describe|explain|experience|worked|years?|marketing|platform)\b/.test(t);

/** Answers from the profile, or null. Never invents: anything not clearly covered returns null. */
export function fromProfile(p: Profile, q: Question, jobLocation = ''): Candidates {
  const t = q.label.toLowerCase().replace(/\s+/g, ' ').trim();
  const opts = q.options ?? [];
  const yesNo = (b: boolean) => (b ? 'Yes' : 'No');
  const nonEmpty = (s: string) => (s ? s : null);

  // "Were you previously employed with Acme?" / "Have you worked at Acme before?": Yes only for a listed employer
  const formerly = t.match(/\b(?:previously|ever|formerly|earlier|before)\b[^?]*?\b(?:employed|worked|working)\s+(?:with|at|for|in)\s+([a-z0-9 .&'-]+?)(?:\s*\?|\s*\(|\s+(?:before|previously|earlier)\b|$)/) ??
    t.match(/\b(?:employed|worked)\s+(?:with|at|for)\s+([a-z0-9 .&'-]+?)\s+(?:before|previously|earlier)\b/);
  if (formerly) {
    const asked = normCompany(formerly[1]);
    const known = [p.currentCompany, ...p.previousEmployers].map(normCompany);
    return asked && known.some((k) => k && (k === asked || k.startsWith(`${asked} `) || asked.startsWith(`${k} `))) ? 'Yes' : 'No';
  }

  // experience first, so "years of experience in mobile development" never reaches the phone rule
  const yearsQ = /how many years|\b(years?|yrs?|months)\b/.test(t) && /\bexp(erience)?\b|\bworked\b|\bworking\b|\bused\b|how many years/.test(t);
  const doYouQ = /\b(do|have|did) you\b/.test(t) && /\bexperience\b|\bworked (with|on|in)\b|\bfamiliar\b|\bused\b/.test(t);
  if (yearsQ || doYouQ) {
    const skillYears = namedSkillYears(t, p.skillYears);
    if (skillYears === null) return null; // a skill we have no number for: never fall back to the total
    if (doYouQ && !yearsQ) return skillYears === undefined ? null : yesNo(skillYears >= 1);
    const years = skillYears ?? p.totalExperienceYears;
    return String(/\bmonths\b/.test(t) && !/\byears?\b/.test(t) ? Math.floor(years * 12) : Math.floor(years));
  }

  // contact details
  const ccDigits = p.countryCode.replace(/\D/g, '');
  if (/\bcountry code\b/.test(t) && !/\b(without|excluding|exclude|no)\b[^.]*country code/.test(t)) {
    // "+91", "91" or an option like "India (+91)"
    return [`+${ccDigits}`, ...(ccDigits === '91' ? ['India (+91)', 'India'] : []), p.countryCode];
  }
  // country of residence, only when the dialling code says India
  if (fieldLike(t) && /^(current )?country( of residence)?\s*\*?$/.test(t) && ccDigits === '91') return 'India';
  if (fieldLike(t) && /\b(phone|mobile|contact number|whatsapp)\b/.test(t)) {
    const digits = p.phone.replace(/\D/g, '');
    const cc = p.countryCode.replace(/\D/g, '');
    const local = p.phone.trim().startsWith('+') && cc && digits.startsWith(cc) ? digits.slice(cc.length) : digits;
    if (q.kind === 'number' || /\b(without|excluding|no)\b[^.]*country code/.test(t)) return local;
    if (/\bwith country code\b/.test(t) && !p.phone.trim().startsWith('+')) return `${p.countryCode} ${local}`;
    return p.phone;
  }
  if (fieldLike(t) && /\be-?mail\b/.test(t)) return p.email;
  if (/\bfirst name\b|\bgiven name\b/.test(t)) return p.firstName;
  if (/\blast name\b|\bsurname\b|\bfamily name\b/.test(t)) return p.lastName;
  if (/\bfull name\b|^(your )?name\s*[:?]?$/.test(t)) return `${p.firstName} ${p.lastName}`;
  // "How did you hear about us (LinkedIn, website...)?" is not asking for a URL
  const source = /\bhear\b|\bsource\b|\brefer/.test(t);
  if (!source && fieldLike(t) && /\blinked ?in\b/.test(t)) return nonEmpty(p.linkedinUrl);
  if (!source && fieldLike(t) && /\bgit ?hub\b/.test(t)) return nonEmpty(p.githubUrl);
  if (!source && fieldLike(t) && /\bportfolio\b|\bwebsite\b/.test(t)) return nonEmpty(p.portfolioUrl);

  // yes/no policies: only for India, or when no country is named
  if (/\bsponsor/.test(t)) return namesOtherCountry(t) ? null : 'No';
  if (/authori[sz]ed|\blegally\b|work permit|eligible to work|right to work/.test(t)) {
    // "the country where this position is located": Yes only when the job itself is in India
    if (/country where (this|the) (position|job|role)/.test(t)) return INDIA_PLACE.test(jobLocation) ? 'Yes' : null;
    return namesOtherCountry(t) ? null : 'Yes';
  }
  // declarations that the information given is true: agree (only when an agreeing option exists)
  if (/information (provided|given|furnished)[^?]*\b(true|accurate|correct)\b|\bi (hereby )?(declare|undertake|confirm|certify)\b/.test(t) && opts.length) {
    return opts.filter((o) => /^(yes|i agree|agree|i accept|accept|i confirm|confirm)\b/i.test(o.trim()));
  }
  if (/relocat/.test(t)) return yesNo(p.willingToRelocate);
  if (/\bon-?site\b|work(ing)? from (the )?office|\bin[- ]office\b|\bhybrid\b|\bcommut/.test(t)) return yesNo(p.okWithOnsite);

  const yesNoOptions = opts.length > 0 && opts.every((o) => /^(yes|no)\b/i.test(o.trim()));
  // "Can you join within 15-20 days?": Yes only if the notice period fits the upper bound
  const within = t.match(/\b(?:join|start)\b[^?]*\bwithin\s+(\d+)(?:\s*(?:-|to)\s*(\d+))?\s*(days?|weeks?|months?)/);
  if (within && (yesNoOptions || !opts.length)) {
    const unit = /month/.test(within[3]) ? 30 : /week/.test(within[3]) ? 7 : 1;
    return yesNo(p.noticePeriodDays <= Number(within[2] ?? within[1]) * unit);
  }
  // "Current Location?- Hyderabad" as a yes/no question
  if (yesNoOptions && /\b(current(ly)? (location|based)|located in|based (in|out of))\b/.test(t)) return yesNo(t.includes(p.city.toLowerCase()));
  // "Fresher or Experienced" style categories
  if (opts.some((o) => /^experienced\b/i.test(o.trim())) && opts.some((o) => /^fresher\b/i.test(o.trim()))) {
    return p.totalExperienceYears >= 1 ? 'Experienced' : 'Fresher';
  }

  // notice period ("are you serving notice" is a different question)
  if (/notice period|how soon can you (join|start)|earliest (joining|date|start|you can join)|when can you (join|start)/.test(t) &&
      !/\bserving\b|last working day/.test(t)) {
    return noticeAnswer(p.noticePeriodDays, t, opts);
  }

  // compensation
  // "What will be your expectations?" on its own means salary expectations
  if (/^(what (will|would|are) (be )?your |your )?(salary )?expectations?\s*\??\s*\*?$/.test(t)) {
    return q.kind === 'number' ? String(Math.round(p.expectedCtcLpa * 100000)) : `${p.expectedCtcLpa} LPA`;
  }
  // plain current/expected CTC only: not hikes, monthly or variable pay, ranges, or "are you okay with ..." questions
  if (/\b(ctc|salary|compensation|package)\b/.test(t) &&
      !/hike|%|percent|increment|monthly|per month|variable|fixed|bonus|component|range|stipend|negotiable/.test(t) &&
      !/^(are|is|would|will|do|does|can|have)\b|\b(ok|okay|comfortable|acceptable|fine with|agree|willing)\b/.test(t)) {
    const lpa = /\b(expect\w*|desired|asking)\b/.test(t) ? p.expectedCtcLpa : p.currentCtcLpa;
    const lakhs = /\b(lakhs?|lacs?|lpa)\b|\bin l\b|\(l\)/;
    if (lakhs.test(t) || opts.some((o) => lakhs.test(o.toLowerCase()))) return String(lpa);
    if (q.kind === 'number') return String(Math.round(lpa * 100000));
    return `${lpa} LPA`;
  }

  // education
  if (/\b(graduation|passing|passed out|completion) year\b|\byear of (passing|graduation|completion)\b/.test(t)) return String(p.graduationYear);
  if (/\bhighest (degree|qualification|education)\b|\bqualification\b|\beducation level\b/.test(t)) {
    const lvl = degreeLevel(p.highestDegree);
    return [p.highestDegree, ...(lvl ? DEGREE_WORDS[lvl] : [])];
  }
  // a dropdown of degrees ("Education Degree": Bachelor of Technology (B.Tech.), ...) gets the highest degree
  const yesNoOpts = opts.length > 0 && opts.every((o) => /^(yes|no)\b/i.test(o.trim()));
  if (fieldLike(t) && /\bdegree\b/.test(t) && opts.length && !yesNoOpts) {
    const key = p.highestDegree.toLowerCase().replace(/[^a-z]/g, '');
    return [p.highestDegree, ...(DEGREE_NAMES[key] ?? [])];
  }
  if (fieldLike(t) && /field of study|\bmajor\b|speciali[sz]ation|\bstream\b|\bdiscipline\b/.test(t)) return p.fieldOfStudy.length ? p.fieldOfStudy : null;
  // only "have you completed a <level> degree?", never years, marks, colleges or current study
  if (/bachelor|\bdegree\b|graduat|master|\bph\.?\s?d\b/.test(t) && opts.length &&
      !/\b(19|20)\d\d\b|%|percent|cgpa|gpa|marks|score|tier|college|university|institute|iit|nit|bits|pursuing|currently|enrolled|batch/.test(t)) {
    const asked = degreeLevel(t) ?? 1;
    const have = degreeLevel(p.highestDegree);
    if (have == null) return asked === 1 ? 'Yes' : null;
    return yesNo(have >= asked);
  }

  // current job
  if (q.kind !== 'textarea' && fieldLike(t) && /\b(current|present|latest|most recent) (company|employer|organi[sz]ation)\b/.test(t)) return p.currentCompany;
  if (q.kind !== 'textarea' && fieldLike(t) && /\b(current|present) (job )?(title|designation|role|position)\b/.test(t)) return p.currentTitle;

  // where you live (after relocation / on-site so "relocate to this city?" is not answered with a city)
  if (!/prefer/.test(t) && (/\bcity\b|\bcurrent(ly)? (location|city)\b|where are you (currently )?(based|located)|^location\b/.test(t))) return p.city;
  return null;
}

/** Answers screening questions: saved answers -> customAnswers -> profile rules -> optional Ollama -> unanswered. */
export class Answerer {
  /** Required questions in this job that got no answer (deduped by label). */
  readonly unanswered: Question[] = [];
  private readonly dryRun: boolean;
  private readonly llm: LlmFn;

  constructor(
    private readonly cfg: Config,
    private readonly store: AnswerStore,
    private readonly job: { url: string; title: string; location?: string },
    opts: { dryRun?: boolean; llm?: LlmFn } = {},
  ) {
    this.dryRun = opts.dryRun ?? false;
    this.llm = opts.llm ?? ((system, user) => askJson<unknown>(cfg, system, user));
  }

  async answer(q: Question, required = true): Promise<string | null> {
    // keep the option strings exactly as given: forms.ts maps the answer back by identity
    const opts = (q.options ?? []).filter((o) => o && o.trim());
    const fit = (raw: Candidates): string | null => {
      for (const c of raw == null ? [] : Array.isArray(raw) ? raw : [raw]) {
        if (!usable(c)) continue;
        const v = opts.length ? matchOption(c, opts) : c.trim();
        if (usable(v)) return v;
      }
      return null;
    };
    const label = q.label.trim();
    const question: Question = { ...q, label, options: opts };

    if (label) {
      const saved = fit(this.store.getAnswer(label));
      if (saved != null) return saved;
      const custom = fit(this.cfg.customAnswers.filter((c) => new RegExp(c.match, 'i').test(label)).map((c) => c.answer));
      if (custom != null) return custom;
      const profile = fit(fromProfile(this.cfg.profile, question, this.job.location));
      if (profile != null) return profile;

      // Ollama only for required questions the rules missed, and only when enabled
      if (required && this.cfg.ollama.enabled) {
        const llm = fit(await this.fromLlm(question));
        // not persisted: saved answers are only the ones the user gave through `npm run review`
        if (llm != null) return llm;
      }
    }

    if (required) {
      if (!this.unanswered.some((u) => u.label === label)) this.unanswered.push(question);
      if (!this.dryRun && label) this.store.addPending(label, q.kind, opts, this.job.url);
    }
    return null;
  }

  private async fromLlm(q: Question): Promise<string | null> {
    let reply: unknown;
    try {
      reply = await this.llm(
        'You fill job application forms for a candidate. Answer ONLY from the candidate profile; never invent facts. ' +
          'If the profile does not clearly contain the answer, reply {"answer": null, "confident": false}.',
        `Candidate profile:\n${JSON.stringify(this.cfg.profile, null, 2)}\n\nJob: ${this.job.title}\n` +
          `Question: ${q.label}\nField type: ${q.kind}\n` +
          (q.options?.length ? `Options (answer must be exactly one of these): ${JSON.stringify(q.options)}\n` : '') +
          'Reply JSON {"answer": string | number | null, "confident": boolean}. Keep text answers under 300 characters.',
      );
    } catch {
      return null;
    }
    // JSON boundary: the model's reply is untyped
    const r = reply as { answer?: unknown; confident?: unknown } | null;
    if (!r || typeof r !== 'object' || r.confident !== true) return null;
    if (typeof r.answer !== 'string' && typeof r.answer !== 'number') return null;
    return String(r.answer);
  }
}
