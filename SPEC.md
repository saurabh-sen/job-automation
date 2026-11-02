# Job Apply Agent: Build Spec

## 0. How to work on this (instructions for Claude Code)

> **Note for anyone using this repo:** this is the original build spec, written in the first person. "I", "me" and "my" mean whoever runs the tool, i.e. you. Your own details (experience, roles, cities, messages) live only in your `config.yaml`. The tool is already built; to set it up, run `/setup` in Claude Code (see README).

You are building a local tool for me, a software engineer in India. Read this whole spec before writing any code.

**Working rules**

1. Start by replying with your proposed project structure, the milestone plan from section 19, and any questions about this spec. Wait for my OK before coding.
2. Build one milestone at a time. At the end of each, run the typecheck and tests, then do a dry run against the live site with my Chrome attached, and show me the output.
3. Never click a final Submit, Apply or Send button on a real job while developing. The only exception is when I explicitly say "go live for <site>". Dry-run mode is the default until then.
4. My agent Chrome profile is logged into every site. You may attach to it read-only to inspect the real DOM and choose selectors (see `npm run inspect` in section 15). Do not guess selectors when you can inspect the live page.
5. The site descriptions in section 7 are my best knowledge and may be outdated. If a site behaves differently from what's written here, tell me and adapt. Don't force the spec onto the page.
6. If a folder named `job-agent` already exists (TypeScript, Naukri and LinkedIn adapters, SQLite, Telegram hand-off), reuse whatever fits. Its selectors were written without access to the live sites, so verify every one of them.
7. Keep a `README.md` up to date as you go: setup, commands, scheduling, and how to fix a broken selector.

## 1. Goal

Every day, without me, the tool:

1. Opens my job sites.
2. Finds jobs recommended for me or matching my saved searches.
3. Clicks Apply on every relevant job that can be applied to inside the site.

My profiles and resumes are already set up on every site. The tool does not upload resumes, edit profiles or write cover letters, apart from the fixed message templates in section 10. It only applies.

When it finds a relevant job it can't apply to, it sends that job to my Telegram with the link and metadata so I can apply manually. The most common case is a job that says to apply on the company's website. Runs that did something end with a Telegram summary (section 11).

**Who I am as a candidate** (an example; each user sets theirs in `config.yaml` → `profile` and `filters`): about 3 years of experience, targeting frontend and full-stack roles at SDE 1, SDE 2 or mid level. I still want to apply when a job asks for 1–2 more years than I have, because HR often agrees to interview anyway (`filters.maxRequiredExperience`).

The tool runs four times a day by default: 08:00, 11:30, 15:00 and 20:00 (section 17, `schedule.times`).

## 2. Scope

There are six sites. They're covered by five adapters, because Y Combinator Jobs and Work at a Startup share one job pool.

| Site | Adapter id | Applies in-site when | Sends to Telegram when |
|---|---|---|---|
| LinkedIn | `linkedin` | Job has Easy Apply | Job applies on the company site; Easy Apply hits a question it can't answer; any failure |
| Naukri | `naukri` | Job has Apply / I am interested | "Apply on company site"; questionnaire it can't answer; any failure |
| Instahyre | `instahyre` | One-click apply | Anything unexpected |
| Wellfound | `wellfound` | Apply plus a note | Job links off-site; any failure |
| Work at a Startup + YC Jobs | `workatastartup` | Apply plus a message to the founder | Any failure |

**Out of scope:** Indeed, company ATS portals (Greenhouse, Lever, Workday and so on), profile editing, resume upload, account creation, captcha solving, and free-form cover letters.

## 3. Tech stack and constraints

**Runtime**
- Node 20+ with TypeScript (strict mode, ESM). Run scripts with `tsx`.
- `playwright-core`, attached to my real Chrome over CDP with `chromium.connectOverCDP`. Do not launch Playwright's bundled Chromium. Do not use stealth or anti-detection plugins.
- Chrome runs on a dedicated profile, using `--user-data-dir=<agent dir> --remote-debugging-port=9222`, because recent Chrome blocks remote debugging on the default profile. If Chrome isn't running when a run starts, the tool launches it with those flags and waits for CDP to come up.

**Libraries**
- `better-sqlite3` for state.
- `yaml` for config, validated with `zod` so a bad config fails fast with a clear message.
- `vitest` for tests.

**External services**
- Telegram Bot API is the only one required.
- Ollama is optional and **off by default**.

**Platform**
- Must work on Windows and macOS. Ask me which one I'm on, and default the paths in the example config to it.

## 4. Project layout

```
job-agent/
  config.example.yaml        # committed; config.yaml is gitignored
  src/
    config.ts                # load + zod-validate config.yaml
    browser.ts               # launch/attach Chrome over CDP
    db.ts                    # SQLite schema + queries
    filters.ts               # relevance rules (section 8)
    answers.ts               # screening-question answers (section 9)
    forms.ts                 # generic form scanner/filler for modal forms
    templates.ts             # message templates (section 10)
    telegram.ts              # send + format (section 11)
    report.ts                # daily markdown report
    run.ts                   # orchestrator (section 6)
    lock.ts                  # single-instance lock
    debug.ts                 # failure screenshots + HTML dumps
    adapters/
      types.ts
      linkedin.ts
      naukri.ts
      instahyre.ts
      wellfound.ts
      workatastartup.ts
    cli/
      chrome.ts  apply.ts  review.ts  telegram.ts  inspect.ts
  tests/
  data/      # gitignored: jobs.db, run.lock
  logs/      # gitignored: run logs, failures/
  reports/   # gitignored: YYYY-MM-DD.md
```

Put each adapter's selectors as named constants at the top of its file, so a broken selector can be fixed in one place.

## 5. Adapter interface

```ts
type SiteId = 'linkedin' | 'naukri' | 'instahyre' | 'wellfound' | 'workatastartup';

interface JobRef { site: SiteId; jobId: string; url: string }

interface JobDetails extends JobRef {
  title: string;
  company: string;
  location: string;          // include workplace type if shown (Remote / Hybrid / On-site)
  experience?: string;       // as shown, e.g. "2-5 Yrs"
  salary?: string;           // as shown
  postedAt?: string;         // as shown, e.g. "3 hours ago"
  applicants?: string;       // as shown
  description: string;
  applyType: 'in_site' | 'company_site' | 'already_applied' | 'unknown';
}

type ReasonCode =
  | 'COMPANY_SITE' | 'UNANSWERED_QUESTIONS' | 'NO_CONFIRMATION' | 'SELECTOR_MISSING'
  | 'FORM_REJECTED' | 'TIMEOUT' | 'CHECKPOINT' | 'UNKNOWN';

interface ApplyOutcome {
  status: 'applied' | 'company_site' | 'needs_review' | 'failed' | 'already_applied';
  reason?: ReasonCode;
  detail?: string;           // human-readable, e.g. the unanswered questions
  externalUrl?: string;      // company apply link, if captured
}

interface SiteAdapter {
  id: SiteId;
  isLoggedIn(page: Page): Promise<boolean>;
  collectJobs(page: Page, cfg: Config): Promise<JobRef[]>;
  getDetails(page: Page, ref: JobRef): Promise<JobDetails>;
  apply(page: Page, job: JobDetails, ctx: ApplyContext): Promise<ApplyOutcome>; // never throws for expected cases
  captureExternalUrl?(page: Page, job: JobDetails): Promise<string | undefined>;
  abandon(page: Page): Promise<void>;       // close any half-filled form without submitting
}

interface ApplyContext { cfg: Config; answers: Answerer; dryRun: boolean }
```

In dry-run mode, `apply()` does everything up to, but not including, the final Submit/Send click. It then calls `abandon()` and returns `{ status: 'applied', detail: 'dry-run' }`, and the orchestrator does not record anything to the database.

Exception: on sites where the first Apply click already submits (Naukri, Instahyre's one-click apply), dry-run stops before that click and logs `would apply`. Their questionnaire handling is first exercised on the live `--limit=2` run.

## 6. Daily run flow

1. Acquire `data/run.lock`. If a fresh lock exists, exit. A lock older than 3 hours counts as stale.
2. Load and validate the config. Attach to Chrome, launching it if needed.
3. For each enabled site (sequentially by default; concurrently in separate tabs if `limits.parallelSites` is true):
   1. If today's applied count for this site has reached its daily cap, skip the site.
   2. Check the login. If logged out, record a run note, which goes in the Telegram summary, and skip the site.
   3. Collect job refs from the discovery URLs, deduped, up to `maxJobsToScanPerSite`.
   4. For each ref the database says hasn't been handled:
      1. **Checkpoint check.** On a captcha, "verify you're human", login wall or unusual-activity screen: stop this site, record a `CHECKPOINT` run note, and move on to the next site.
      2. **Read details.** If this fails, record `failed` with `TIMEOUT` or `SELECTOR_MISSING`.
      3. **Already applied:** record it and continue.
      4. **Filters (section 8).** If the job fails, record `skipped` with the reason and continue.
      5. **Cross-site duplicate:** if I already applied to the same company and a normalized-equal title on another site in the last 21 days, record `skipped` ("applied via <site>").
      6. **Company-site job:** call `captureExternalUrl` (open the popup, read its final URL, close it without touching it). Record `company_site` with the link.
      7. **Otherwise apply** and record the outcome. If the outcome isn't `applied`, call `abandon()` and save a failure screenshot and HTML (section 14).
      8. After any apply attempt, wait a random `delayBetweenAppliesMs`.
4. Send the Telegram hand-offs (section 11), then the summary message if the summary rule says so. Write `reports/YYYY-MM-DD.md` (rewritten each run, covering the whole day so far).
5. Disconnect from Chrome. Don't close my Chrome or its other tabs; close only the tabs this run opened. Release the lock.

Between individual UI actions, wait a random 0.5–2 seconds. The browser is always headed.

## 7. Site-by-site behaviour

Treat everything here as "verify against the live DOM first".

### 7.1 LinkedIn (`linkedin`)

**Discovery**
- Sources: `https://www.linkedin.com/jobs/collections/recommended/`, plus search URLs from the config.
- Do **not** force the Easy Apply filter (`f_AL=true`). I want company-site jobs to reach Telegram.
- Paginate with `&start=25`, and scroll the results list to load more cards.

**Job identity**
- Job ID: the numeric `data-job-id` / `data-occludable-job-id` on the job cards.
- Canonical URL: `https://www.linkedin.com/jobs/view/<id>/`.

**Details**
- Read the title, company, location with workplace type, posted time, applicant count and full description. Click "see more" to expand the description first.

**Easy Apply (in-site)**
- The button is labelled "Easy Apply" and opens a multi-step modal.
- Walk the steps with the buttons whose aria-labels are "Continue to next step", then "Review your application", then "Submit application".
- On every step, fill the empty required fields through `forms.ts` and `answers.ts`.
- Leave the preselected resume as it is.
- Uncheck "Follow <company>".
- If an inline validation error appears after Next, return `FORM_REJECTED` with the error text.
- After submitting, dismiss the confirmation dialog.

**Company site**
- These jobs have an "Apply" button without Easy Apply, which opens a new tab. Capture that tab's URL as `externalUrl`, close the tab, and record `company_site`.

**Already applied:** the page shows "Applied <time> ago".

**Abandon:** click "Dismiss", then "Discard" in the confirmation dialog.

### 7.2 Naukri (`naukri`)

**Discovery**
- Sources: `https://www.naukri.com/mnjuser/recommendedjobs`, plus search URLs from the config (for example `https://www.naukri.com/react-developer-jobs-in-hyderabad?experience=3&jobAge=1`).
- Scroll to load more results.
- Job links contain `/job-listings-`. The job ID is the trailing digits of the URL.

**Details**
- Read the title, company (without the rating text), experience range, salary, location, posted time, openings/applicants and description.

**Apply (in-site)**
- The button is "Apply" (`#apply-button`) or "I am interested".
- After clicking, one of these happens:
  - **Success:** a message like "successfully applied" appears, or the button changes to "Applied".
  - **Questionnaire:** a recruiter chat drawer opens with one question at a time (chips or radio buttons, or a text box, then Save). Answer each question through `answers.ts`. If any answer is unknown, close the drawer and return `UNANSWERED_QUESTIONS` with the question text. If the same question repeats after an answer, return `FORM_REJECTED`.

**Company site:** the button is "Apply on company site" (`#company-site-button`). Capture the popup URL as `externalUrl`.

**Note:** Naukri always uses my profile resume. Don't touch it.

**Dry-run:** clicking Apply submits immediately, so dry-run stops before the click (section 5). On a live run, a questionnaire with any unanswerable question is closed and the job goes to Telegram as `needs_review`, listing the questions as the reason.

### 7.3 Instahyre (`instahyre`)

**Discovery**
- Source: the logged-in candidate opportunities feed (I believe it's `https://www.instahyre.com/candidate/opportunities/`; verify).
- Each card links to a job detail view.

**Apply**
- Applying is one click ("Apply" / "Interested" on the card or the detail view).
- Success: confirm the card or button changes state.
- If a form or question appears, use `forms.ts`. If anything is unanswerable, return `UNANSWERED_QUESTIONS`.

**Metadata:** read whatever the card shows (experience, salary, location, skills).

### 7.4 Wellfound (`wellfound`)

**Discovery**
- Source: `https://wellfound.com/jobs` (the logged-in recommended feed), plus any search URLs I add.
- Jobs are grouped under companies. Collect each job's own URL and ID.

**Apply**
- "Apply" opens a panel or modal with a note to the hiring team, which is usually required.
- Fill the note from the `wellfound` template (section 10), then click the send/submit button.
- Success: the job shows as applied.

**Company site:** jobs that link off-site get `company_site` with `externalUrl`.

**Metadata:** read salary and equity, location and remote policy, visa sponsorship, and company size if shown.

### 7.5 Work at a Startup + YC Jobs (`workatastartup`)

**Discovery**
- Source: `https://www.workatastartup.com/companies` with my filters applied (I'll set them in the site's UI and paste the resulting URL into the config).
- Optionally also take YC jobs board URLs (`https://www.ycombinator.com/jobs...`).
- Normalize every job to its Work at a Startup job ID and URL (`/jobs/<id>`) so the two sources never create duplicates.
- As far as I know, applying from the YC board also goes through the Work at a Startup account. Verify this and tell me.

**Apply**
- "Apply" opens a modal with a message to the founder. Fill it from the `workatastartup` template, then click Send.
- Success: the job shows as applied.

**Filtering notes**
- Most roles are US-based, so the location filter matters here.
- Also skip jobs whose text requires US citizenship or US work authorization, or says no visa sponsorship, unless the role is remote-friendly for India.

## 8. Filters (`filters.ts`)

Filters apply before any apply attempt **and** before sending a company-site job to Telegram, so I only hear about relevant jobs. All rules come from config. Matching is case-insensitive.

| Rule | Behaviour |
|---|---|
| Excluded companies | Skip if the company contains any entry (put your current employer here) |
| Excluded title keywords | Skip if the title contains any entry (lead, manager, principal, architect, intern, etc.) |
| Included title keywords | Skip unless the title contains at least one entry |
| Experience | Parse the minimum years from the experience field, or else from the description (patterns like `3-6 Yrs`, `5+ years of experience`). Skip only if the minimum is above `maxRequiredExperience` (default 5, so "4+", "5+", "3-6" and "5-8" all apply, while "6+" is skipped). Ignore numbers not tied to experience. |
| Location | Skip unless the location contains an allowed entry, or the job is remote |

**Target roles.** Frontend and full-stack roles, plus generic titles like Software Engineer, SDE 1/2 or Software Developer. "Senior" titles are allowed and left to the experience rule. SDE 3, Staff, Lead, Principal, Manager and Architect titles are excluded. So are pure mobile, QA, devops and data roles.

Every skip records a short, human-readable reason. The report groups the skips by reason.

## 9. Screening questions (`answers.ts`, `forms.ts`)

**`forms.ts`** scans a container (a modal or form) for visible inputs, textareas, selects, radio groups and checkboxes. For each field it resolves the label text (from `label[for]`, `aria-labelledby`, `aria-label`, a wrapping label, a fieldset legend, or nearby text) and whether it's required. Then:
- Pre-filled fields are left untouched.
- Required checkboxes, such as terms acceptance, get ticked.
- Every other empty field gets an answer from `answers.ts`.
- If any **required** field has no answer, nothing is submitted. The application is abandoned and returned as `UNANSWERED_QUESTIONS` with the list of questions.

**`answers.ts`** resolves an answer in this order:
1. Saved answers in the database (answers I gave through `npm run review`).
2. `customAnswers` in the config (regex on the question text, mapped to an answer).
3. Profile rules: name, email, phone, city, LinkedIn/GitHub URLs, total years of experience, years per skill (`skillYears`), notice period (days, or months when asked in months), current and expected CTC (in lakhs when the question says lakhs/LPA; otherwise full rupees for numeric fields), relocation, on-site/hybrid OK, work authorization in India (Yes), sponsorship needed (No), degree completed (Yes), current company and title.
4. Ollama, only if `ollama.enabled` is true. Use it only for questions the profile clearly answers. It must reply `{ "answer": ..., "confident": boolean }` and its answer is used only when it's confident.
5. Otherwise, unanswered.

**Option matching.** When a field has options, the answer must map onto one of them: an exact match, then a prefix match (a bare number must match a whole token, so "1" never picks "15 days"), then a contains match, then numeric ranges ("3-5 years", "5+ years"), with 0 mapping to "Immediate".

**Never** invent an answer, and never submit a placeholder or a TODO value. If a config value is still TODO, treat the question as unanswered.

`npm run review` lists the queued questions with numbered options and saves my answers for future jobs. Jobs that already went to Telegram are not retried.

## 10. Message templates (`templates.ts`)

The templates live in the config and support the variables `{firstName}`, `{company}` and `{role}`. Keep each message within the site's character limit, trimming at a sentence boundary. There are no built-in defaults: each user writes their own (the `/setup` skill drafts them from the profile), and a site that needs a template refuses to run without one. Example:

```yaml
templates:
  workatastartup: |
    Hi, I'm {firstName}, a software engineer with 3 years of experience building web
    applications at Acme. The {role} role at {company} looks like a strong fit and I'd love to talk.
  wellfound: |
    Hi {company} team, I'm {firstName}, a frontend engineer with 3 years of experience in React
    and TypeScript. I'm interested in the {role} role and would be glad to share more. Thanks!
```

## 11. Telegram (`telegram.ts`)

**Setup.** `npm run telegram` does two things:
- If `chatId` is empty, it calls `getUpdates` and prints the chat IDs of anyone who has messaged the bot.
- Otherwise it sends a test message.

**What gets sent.** One message per job with status `company_site`, `needs_review` or `failed`, so each job is its own task I can act on. Use HTML parse mode, escape `& < > "`, and disable link previews.

```
Apply on company site · LinkedIn
Frontend Engineer at Acme
Hyderabad (Hybrid) · 2–5 yrs · ₹18–25 LPA · posted 3 hours ago · 40 applicants
Apply here: https://acme.greenhouse.io/...
Job post: https://www.linkedin.com/jobs/view/123/
```

```
Needs your answers · Naukri
Full Stack Developer at Beta
Bengaluru · 3–6 yrs · Not disclosed
• Are you comfortable with a 6-day work week?
• Rate your Kotlin skills out of 10
Job post: https://www.naukri.com/job-listings-...
```

```
Agent could not finish · Wellfound
React Engineer at Gamma
Reason: no confirmation after Send. It may have gone through; check before re-applying.
Job post: https://wellfound.com/jobs/...
```

Show only the metadata fields that exist.

**Summary message.** Send it after a run only if that run applied to, handed off or failed at least one job, or recorded a run note (captcha, logout, crash). The 20:00 run always sends a summary covering the whole day, even if nothing happened, so I know the tool ran.

```
Job agent · 31 Oct
Applied 22 (LinkedIn 8 · Naukri 9 · Instahyre 3 · Wellfound 1 · Work at a Startup 1)
Sent to you 6 · Skipped 41 · Failed 1
Naukri: stopped at a captcha. Clear it in Chrome; the next run continues.
```

**Delivery rules**
- Space messages at least 1.1 seconds apart. On a 429 response, wait `retry_after` and retry up to 3 times.
- A job is marked `notified` only after Telegram accepts the message. Anything unsent goes out on the next run, limited to jobs from the last 7 days.
- A notified job is mine and is **never retried** by the tool, so I never double-apply.
- If Telegram is disabled, `needs_review` jobs retry after `npm run review`, and `failed` jobs retry up to 3 times.
- A run that can't start at all (Chrome won't attach, config invalid after load) still sends a short Telegram error message.

## 12. Database schema (`db.ts`)

```sql
CREATE TABLE IF NOT EXISTS jobs (
  site TEXT NOT NULL,
  job_id TEXT NOT NULL,
  url TEXT NOT NULL,
  external_url TEXT,
  title TEXT, company TEXT, location TEXT, experience TEXT, salary TEXT,
  posted_at TEXT, applicants TEXT,
  status TEXT NOT NULL,       -- applied | skipped | company_site | needs_review | failed | already_applied
  reason TEXT,                -- ReasonCode or skip reason
  detail TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,   -- incremented on failed only
  notified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (site, job_id)
);
CREATE TABLE IF NOT EXISTS answers (
  key TEXT PRIMARY KEY,       -- normalized question text
  question TEXT, answer TEXT, source TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS pending_questions (
  key TEXT PRIMARY KEY, question TEXT, kind TEXT, options TEXT, job_url TEXT, created_at TEXT
);
```

A job is processed only if it's new, or if it is `failed` / `needs_review` with `notified = 0` and `attempts < 3`. `applied`, `skipped`, `company_site` and `already_applied` are final. Store timestamps as ISO UTC and compare "today" in local time. Add simple column migrations so older databases keep working.

## 13. Safety, pacing and limits

| Setting | Default |
|---|---|
| Daily cap per site | LinkedIn 15, Naukri 25, Instahyre 30, Wellfound 15, Work at a Startup 10 |
| Max jobs scanned per site per run | 60 |
| Delay between applications | random 20–60 s |
| Delay between UI actions | random 0.5–2 s |
| Runs per day | 4 (08:00, 11:30, 15:00, 20:00). Daily caps are shared across all four runs |

**Hard rules**
- Stop a site immediately at any checkpoint, captcha or login wall, and notify me. Never try to solve or bypass one.
- No stealth plugins and no fingerprint spoofing. Keep the browser headed.
- Only one run at a time (the lock file).
- Never touch my personal Chrome profile. Only use the agent profile directory from the config.

I understand LinkedIn's terms prohibit automated applying. Keep its cap the lowest.

## 14. Failure handling and debugging

- **Failure snapshots.** On any non-`applied` outcome other than `company_site` and filter skips, save `logs/failures/YYYY-MM-DD/<site>-<jobId>.png` (a full-page screenshot) and `.html` (the outer HTML of the page or modal).
- **Run log.** Each run appends to `logs/run-YYYY-MM-DD.log` with timestamps. Console output should be readable one line per job, e.g. `APPLIED  Frontend Engineer @ Acme (linkedin)`.
- **`npm run inspect -- --site=<id> [--url=<url>]`** attaches to Chrome, opens the URL (or the site's first discovery URL), and prints the visible buttons, links, inputs and dialogs with their role, accessible name and a suggested Playwright locator. It's read-only. This is the tool for fixing selectors later.
- **Selector strategy.** Prefer `getByRole` and accessible names, then stable ids and attributes, then class substrings (`[class*="..."]`) for CSS-module class names. Avoid nth-child chains.

## 15. CLI commands

| Command | Does |
|---|---|
| `npm run chrome` | Launch Chrome on the agent profile with the 5 sites open, so I can log in once |
| `npm run apply` | Full run on all enabled sites |
| `npm run apply -- --site=naukri` | One site only |
| `npm run apply -- --dry-run` | Everything except the final submit; records nothing |
| `npm run apply -- --limit=3` | Stop after 3 apply attempts (for testing) |
| `npm run review` | Answer queued screening questions |
| `npm run telegram` | Find my chat ID or send a test message |
| `npm run inspect -- --site=<id>` | Selector inspection (read-only) |
| `npm test` / `npm run typecheck` | Tests and type checking |

## 16. Config (`config.example.yaml`)

The full, commented config is [`config.example.yaml`](config.example.yaml). Sections:

- `chrome`: CDP URL (default `http://127.0.0.1:9333`), optional `executablePath` (auto-detected per OS), and the dedicated `userDataDir`.
- `telegram`: `botToken`, `chatId`, `dailySummaryAfter`.
- `ollama`: optional local model.
- `profile`: name, contact details, current and previous employers, total and per-skill years, notice period, current and expected CTC (lakhs), relocation and on-site, degree, field of study, graduation year.
- `customAnswers`: regex on question text → answer.
- `templates`: section 10.
- `filters`: include and exclude title keywords, excluded companies, locations, `maxRequiredExperience`.
- `limits`: daily caps per site, jobs scanned per site, delays, `parallelSites`.
- `schedule.times`: the daily run times.
- `sites.<id>`: `enabled`, `live`, `discoveryUrls`.

Every value the user must supply starts as `TODO`, and the tool refuses to run until none are left.

## 17. Scheduling

Runs at `schedule.times` (default 08:00, 11:30, 15:00 and 20:00), logging to `logs/`. `npm run schedule:install` / `schedule:uninstall` / `schedule:status` handle every OS:

- **macOS:** a `launchd` plist in `~/Library/LaunchAgents` with one `StartCalendarInterval` per time. Unlike cron, launchd runs a missed job when the Mac wakes from sleep.
- **Windows (beta):** one Task Scheduler task per time ("JobAgent HHMM"), each running a generated `data/scheduled-run.cmd`. Runs only while the user is signed in and the PC is awake.
- **Linux (beta):** a systemd user service and timer (`~/.config/systemd/user/job-agent.*`) with `Persistent=true`, carrying the desktop session's `DISPLAY`/`WAYLAND_DISPLAY` so Chrome can open.

Keep runs at least 3 hours apart, because a lock older than 3 hours counts as stale. The machine must be on. The run launches Chrome if it isn't already open.

## 18. Testing

**Unit tests (vitest)**
- Filter rules and the experience parser.
- Option matching, including the "1" vs "15 days" case.
- Each profile answer rule, including the lakhs vs rupees cases.
- TODO values are never used as answers.
- Template variable filling and trimming.
- Telegram formatting and HTML escaping.
- Database status transitions (a notified job is never reprocessed; failed jobs stop after 3 attempts).
- YC-to-Work-at-a-Startup URL normalization.
- Cross-site duplicate detection.

**Form filler tests.** Use local HTML fixtures that mimic each site's form patterns (label variants, radio fieldsets, selects with a placeholder option, required markers), run in my installed Chrome via `chromium.launch({ channel: 'chrome' })`.

**Live verification.** A `--dry-run` per site with me watching. Then go live on one site at a time with `--limit=2` after I say so.

## 19. Milestones

1. **Core.** Config + validation, browser attach, database, lock, filters, answers, forms, templates, Telegram (setup command, formatting, sending), report, CLI skeleton, unit tests. Plus the `inspect` command.
2. **Naukri adapter.** Dry run, then live with `--limit=2` after my OK.
3. **LinkedIn adapter**, including company-site URL capture.
4. **Instahyre adapter.**
5. **Wellfound adapter.**
6. **Work at a Startup / YC adapter**, including normalization.
7. **Polish.** Parallel sites option, scheduling docs, README, end-to-end run on all sites.

Don't start a milestone until the previous one passes its dry run and I've confirmed.

## 20. Definition of done

1. `npm run apply` runs unattended on all five adapters and respects the caps, delays, filters and lock.
2. Every relevant company-site job reaches Telegram with its title, company, the metadata available and the job link, plus the direct company link when it could be captured.
3. Every job the tool couldn't finish reaches Telegram with a clear reason, and is never retried after that.
4. The tool never submits an application with a guessed or TODO answer.
5. A captcha or logout on any site stops that site and is reported in the Telegram summary; the other sites continue.
6. Each run writes the markdown report. Telegram summaries follow the rule in section 11, and the 20:00 run always sends one.
7. Any failure leaves a screenshot and an HTML snapshot, and `npm run inspect` makes fixing a selector a few-minute job.
8. The typecheck passes and all tests pass. The README covers setup, the commands, scheduling and selector fixing.