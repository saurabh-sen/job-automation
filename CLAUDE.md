# CLAUDE.md: job-agent

## What this project is

A local tool that applies to jobs every day from the user's own logged-in agent Chrome. It covers LinkedIn, Naukri, Instahyre, Wellfound, and Work at a Startup (which also covers YC Jobs). Jobs it can't apply to are sent to their Telegram: company-site applications, questions it can't answer, and failures.

The full requirements are in `SPEC.md`. Read the relevant section before changing any behaviour. On *what the product does*, `SPEC.md` wins. On *how to work in this repo*, this file wins.

## Status

The tool is complete: core, all five site adapters, parallel runs, scheduling on macOS (Windows and Linux in beta), and `/setup` onboarding. Which sites are live for *this* user is in `config.yaml` (`sites.<id>.live`); never infer it from these docs.

**Local notes:** if `CLAUDE.local.md` exists, read it first. It holds this machine's owner, status and quirks, and is gitignored.

**Setting up a new user:** follow `.claude/skills/setup/SKILL.md` (in Claude Code: `/setup`). It drives `npm run setup:check` until every step passes.

## Commands

```bash
npm run chrome                          # launch agent Chrome profile with the 5 sites (login once)
npm run apply -- --dry-run              # full run, no final submit, nothing recorded
npm run apply -- --site=naukri --dry-run --limit=3
npm run apply                           # real run (only for live sites)
npm run review                          # answer queued screening questions
npm run telegram                        # send a test message (`-- --save` fills chatId after you message the bot)
npm run setup:check                     # every setup step, ✅/❌ with the fix (`-- --json`, `-- --no-logins`)
npm run schedule:install                # macOS launchd / Windows Task Scheduler / Linux systemd timer (status, uninstall)
npm run inspect -- --site=<id> [--url=<url>]   # read-only DOM inspection for selectors
npm run typecheck && npm test           # must pass before any task is done
```

## Architecture map

- `src/config.ts` loads `config.yaml` and validates it with zod. It refuses to run with TODO values or missing Telegram settings.
- `src/platform.ts` finds Chrome per OS and reports OS support (macOS supported; Windows and Linux beta).
- `src/browser.ts` attaches over CDP to the agent Chrome profile and launches it if needed.
- `src/db.ts` holds the SQLite tables `jobs`, `answers` and `pending_questions`, and decides whether a job should be processed.
- `src/filters.ts` applies the relevance rules (title, experience, location, excluded companies).
- `src/answers.ts` answers screening questions, in this order: saved answers → `customAnswers` → profile rules → optional Ollama → unanswered.
- `src/forms.ts` is the generic modal/form scanner and filler.
- `src/templates.ts` fills the Wellfound and Work at a Startup message templates.
- `src/telegram.ts` sends one message per hand-off job plus a run summary.
- `src/run.ts` orchestrates a run: lock → sites → filters → apply → record → Telegram → report. `sites.<id>.live: false` forces a dry run for that site.
- `src/lock.ts` holds the single-run lock; `src/debug.ts` saves failure snapshots; `src/report.ts` writes the daily report.
- `src/adapters/<site>.ts` holds one adapter per site, with its selectors as named constants at the top of the file.
- `src/cli/*` contains the entry points for the npm scripts. `setup-check.ts` is read-only and drives `/setup`; `schedule.ts` has one installer per OS.
- `.claude/skills/setup/SKILL.md` is the onboarding script for a new user (Claude Code `/setup`; other agents read it directly).
- `tests/` has the vitest unit tests; `tests/fixtures/` has HTML fixtures for the form filler.

## Hard rules

1. **No real submissions unless the site is live.** Never click a final Submit, Apply or Send on a real job unless `sites.<id>.live: true` in `config.yaml`, which is set only when the user says "go live for <site>". While developing, always use `--dry-run`, and add `--limit` for the first live runs.
2. **Stop at checkpoints.** Never solve, bypass or retry past captchas, "verify you're human" screens, login walls or unusual-activity screens. Stop that site and report it.
3. **Real Chrome, agent profile only.** No stealth or anti-detection plugins, and no bundled Chromium. Attach over CDP to the agent profile (`chrome.userDataDir`) only, and never touch the user's personal Chrome profile.
4. **No guessed answers.** Never submit a guessed or TODO answer. If a required question has no answer, abandon the form and mark the job `needs_review`.
5. **Hand-offs are final.** A job already sent to Telegram (`notified = 1`) is never retried.
6. **Don't touch profiles.** Never edit the user's site profiles or resumes. The tool only applies.
7. **Keep secrets out.** Never commit, log or print `config.yaml` values (bot token, phone, CTC), `data/`, `logs/` or `reports/`. Never copy config values into code, tests or fixtures.
8. **Ask before loosening safety.** Ask before raising daily caps, shortening delays, or adding a new site.

## Working with live sites

- **Inspect first.** Before writing or fixing a selector, run `npm run inspect -- --site=<id>` against the running agent Chrome. Don't guess selectors.
- **Selector priority.** Use `getByRole` with an accessible name first. Then stable ids or data attributes. Then `[class*="..."]` substrings for CSS-module class names. Avoid nth-child chains and long CSS paths.
- **When reality differs from the spec.** If a site behaves differently from `SPEC.md` section 7, tell the user, adapt the adapter, and record the finding under "Site notes" below.
- **Debugging a failure.** Start with `logs/failures/<date>/<site>-<jobId>.png` and `.html`, then the run log.
- **Verifying an adapter change.** Run `npm run apply -- --site=<id> --dry-run --limit=3`, show the user the output, and wait for their OK.

## Code conventions

- TypeScript strict mode, ESM, `.js` extensions on relative imports. No `any`, except at JSON or DOM boundaries, and then with a comment.
- Adapters return an `ApplyOutcome` with a reason code for expected cases (company site, unanswered questions, no confirmation, form rejected). Throw only for truly unexpected errors.
- Code passed to `page.evaluate` runs under tsx, which wraps named inner functions in `__name(...)`. Either pass a string, or define the shim first (see `scanFields` in `src/forms.ts`). Vitest doesn't reproduce this, so check new in-page code with `npx tsx`.
- Open pages with `openBackgroundPage()` (CDP `Target.createTarget` with `newWindow` and `background`), never `context.newPage()`, which brings Chrome to the front on macOS. A background launch uses `open -g` and `--no-startup-window`, together with `BACKGROUND_FLAGS`, so hidden windows aren't throttled. Verified 2026-11-02: no focus change from a cold launch, and clicks work.
- Never `force: true` a click inside a form. It clicks the screen position, which may be the Next or Submit button. For hidden inputs, use `dispatchEvent('click')`.
- Wait on locators rather than fixed sleeps. Human-like pauses go through the shared jittered `pause()` helper.
- Every recorded job has a status and a reason. Every message the user sees (Telegram, report, console) is short and human-readable.
- Console output is one line per job, e.g. `APPLIED  Frontend Engineer @ Acme (naukri)`.
- Pure logic is covered by vitest unit tests. When you fix a parsing or matching bug, add a test for it.
- The form filler is tested against the HTML fixtures, running in the installed Chrome (`channel: 'chrome'`).
- Keep changes scoped to the task, and don't refactor unrelated code.
- If this is a git repo, commit after each milestone passes, e.g. `M2: Naukri adapter`.

## Workflow for each milestone

1. Re-read the relevant `SPEC.md` sections and propose a short plan. Wait for the user's OK.
2. Implement it.
3. Run `npm run typecheck && npm test`.
4. Dry-run it on the live site and show the output.
5. Update this file: the Status table, plus Site notes if anything changed. Keep `README.md` current with setup, commands, scheduling and how to fix a selector.
6. Wait for the user's OK before starting the next milestone.

## Communicating with the user

- Keep updates short and direct: what was done, what was verified, what's next, and anything needing their decision.
- Ask one clear question when the spec is ambiguous, rather than inventing product behaviour.
- When a step needs them (logging in, clearing a captcha, filling a config value, approving go-live), say exactly what to do.

## Site notes

Append verified findings here: URLs, selectors that work, quirks and success signals.

- **linkedin:** (verified 2026-11-02; new layout with hashed class names, so use roles, names and the page title)
  - Discovery: `/jobs/collections/recommended/` gives 24 jobs per page, and `&start=25` gives the next 24. `/jobs/search/` redirects to `/jobs/search-results/`, 25 cards per page. Job ids are found in the HTML: `componentkey="job-card-component-ref-<id>"` (search), `data-occludable-job-id` (recommended) and `/jobs/view/<id>`.
  - Job page: the page title is `<title> | <company> | LinkedIn`. `region "Primary content"` holds the top line `<location> · <posted> · <applicants>`, links "On-site", "Remote", "Hybrid" and "Full-time", and the text after the heading "About the job".
  - Apply states: Easy Apply is the button "Easy Apply to this job". Company site is the link "Apply on company website", whose href is `safety/go/?url=<company url>`, so it can be read without a click. Already applied shows the heading "Application status" (e.g. "Applied on company site"). Look for these only inside "Primary content": the "similar jobs" cards further down also say "Easy Apply".
  - Easy Apply modal: a native `<dialog>` named "Apply to <company>", with a progressbar and "N/M pages". Buttons are "Next", then "Review", then "Submit application"; "Dismiss" then "Discard" closes it. The click does nothing until the page settles (wait for networkidle, retry once). Each step shows its header before its fields (wait for a step button). Email, phone and country code are pre-filled from the profile.
  - Education step: "Education Degree*" and "Education Field of Study*" are required `<select>`s that only open after Next on a summary card. They're filled from `highestDegree` and `fieldOfStudy`.
  - Applied jobs list: `/jobs-tracker/`, filtered by clicking the text "Applied · N" (the checkbox itself is hidden). No job links there; ids are in the HTML.
- **naukri:** (verified read-only 2026-11-02)
  - Discovery: `/mnjuser/recommendedjobs` has 5 tabs ("Applies", "Handpicked for you", "Profile", "Preferences", "You might like", ~70 jobs each); "Applies" is selected by default. Cards are `div.jobTupleHeader` with `a[href*="/job-listings-"]`. A bulk **`button.multi-apply-button` ("Apply")** sits at the top of the feed. Never click it.
  - Job ID is the trailing 12 digits of the URL. `https://www.naukri.com/job-listings-<id>` resolves to the job.
  - Detail page (CSS-module classes, so use substrings): title `[class*="jd-header-title"]`; company `[class*="jd-header-comp-name"] a` (the container also holds the rating text); experience `[class*="jhc__exp"]` ("5 - 8 years"); salary `[class*="jhc__salary"]`; location `[class*="jhc__location"]`; stats `[class*="jhc__stat"]` ("Posted: 1 day ago", "Openings: 1", "Applicants: 100+"); description `[class*="dang-inner-html"]`.
  - Apply states: in-site `button#apply-button` "Apply"; company site `button#company-site-button` "Apply on company site"; already applied `span#already-applied` "Applied" (a span, not a button).
  - Search `/frontend-developer-jobs?experience=3` is mostly company-site jobs. The recommended feed and `react-developer-jobs-in-hyderabad?jobAge=1` were all in-site.
  - Success (first live run, 2026-11-02): clicking `#apply-button` navigates to an **"Apply Confirmation"** page (page title) with `[class*="applied-job-content"]` reading `Applied to "<title>"`. No questionnaire appeared for those two jobs.
  - Questionnaire (seen 2026-11-02): `div.chatbot_Drawer` opens after Apply, one question at a time. A greeting comes first, then questions in `div.botMsg` (text in a span) and your answers in `div.userMsg`. Text answers go in `div.textArea[contenteditable]` inside `chatbot_InputContainer`, and `div.sendMsg` ("Save") sends them. Close it with `div.crossIcon`. **The bot shows an empty "typing" botMsg before each question**, so wait for its text. Questions seen: "How many years of experience do you have in Core Java?" and "...in Microservices?". Choice questions are radio rows `div.ssrc__radio-btn-container` > `input.ssrc__radio` + `label.ssrc__label` ("0-4", "4-8", ...). Clicking the row div does not select it; click the label.
- **instahyre:** (verified read-only 2026-11-02; AngularJS app)
  - Discovery: `/candidate/opportunities/` (redirects to `?matching=true`) shows "N jobs recommended for you", with 30 `.employer-block` cards per page and page links `[ng-repeat^="pageNumber in pages"]`. Cards have no ids or links in the DOM. Read them from `angular.element(card).scope().opp.job`: `id`, `opportunity_url` (`/job-<id>-<slug>/`), `title`, `hiring_company_name`, `locations`.
  - Job page `/job-<id>-<slug>/`: `h1` title, `h2` "at <company>", then a line "<locations> <N-M Years>", and the text under "Job Description".
  - Apply: button **"Apply now"** (`ng-click=submitChoice(opp, true)`) submits in one click, so dry runs never click it. The card's "View job »" only opens a details panel (`.application-modal-block`) with "Apply" and "Not interested".
  - "Apply now" sits inside `<a class="text-center" ng-if="... && !job.applied_on">`, which Playwright reports as intercepting the click, so it's clicked with `force: true`. Once applied, `job.applied_on` is set and the button goes away.
  - Not seen yet: the page after a real "Apply now" click, and how an already-applied job looks.
- **wellfound:** (verified 2026-11-02)
  - Discovery: `/jobs` shows the saved search (role, location, job type) as "N results". It loads more jobs as you scroll (19, then 33, then 46). Job links are `/jobs/<id>-<slug>`; **`/jobs/<id>` without the slug is a 404**. The HTML includes Cloudflare scripts, so don't treat the word "cloudflare" as a checkpoint.
  - Job page title: `<role> at <company> • <location> | Wellfound`. The `h1` holds `<role> at <company>`, then a line with salary and "Posted N ago", then the description (which often has "Experience: N+ years").
  - Apply: the button "Apply" opens a ReactModal `dialog` with: Location, Remote work policy, Job type, Visa sponsorship, Relocation and Experience; a textarea "What interests you about working for this company?" (`customQuestionAnswers[...]`, filled from the `wellfound` template); and the buttons "Send application" (`data-test=JobApplicationModal--SubmitButton`, submits) and "Cancel". Escape closes it.
  - Success (first live run, 2026-11-02): the modal **stays open** and shows "Success! Your application has been sent." plus an AI-interview upsell; Escape closes it. Applied jobs are listed at `/jobs/applications` as "Pending".
  - Not seen yet: a company-site job.
- **workatastartup:** (2026-11-01) The logged-in header on `/companies` shows "Inbox" (`/conversations`) and "My profile" (`/application`). A visible "Sign in" link to `/application` is still there when logged in, so it is not a logout signal. Login is a YC SSO session (`account.ycombinator.com`).
  - Discovery (2026-11-02): `/companies` (the directory) lists companies with their jobs, and more load as you scroll. Job ids come from links `/jobs/<id>`. The unfiltered directory is mostly non-engineering and US roles, so use the user's filtered URL.
  - Job page `/jobs/<id>`: title `<role> at <company> | Y Combinator's Work at a Startup`, then a fact list (Location, Job type, Salary, Experience, Visa sponsorship, Skills), then "About the role". "Apply" is an `<a>` **without href** (no link role), so find it by text. "Applied" marks an already-applied job.
  - Apply dialog: `dialog "Reach out to <founder> at <company>"` (the `<dialog>` element itself has zero size, so wait for its textbox), with a textbox "Your message", "Send" (disabled until the message is written) and "Close". It may show YC's warning "This may not be a match".
  - **Limit: 5 applications per week.** Over the limit, `POST /apply` returns 200 and then the page shows an `alert` "You've reached your limit of 5 applications per week." Close and Send stay disabled until it's dismissed. The adapter returns `SITE_LIMIT`, and run.ts pauses the site for 24 h (meta `site_limit:<id>`) without recording the job.
  - Not seen yet: a successful send (the limit was already used on 2026-11-02), and YC jobs board URLs (not collected yet).