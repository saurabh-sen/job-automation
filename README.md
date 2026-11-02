# job-agent

Applies to jobs for you several times a day from a dedicated, logged-in Chrome on your computer. It covers LinkedIn, Naukri, Instahyre, Wellfound and Work at a Startup (which includes YC Jobs). Anything it can't apply to (company-site jobs, questions it can't answer, failures) goes to your own Telegram bot with the link, and so do logouts and captchas.

It's a plain Node.js program: no LLM, API key or Claude Code is needed to *run* it. Every decision is a rule in the code or your config. An AI coding agent is only a convenient way to *set it up*.

| OS | Status |
|---|---|
| macOS | Supported, used daily |
| Windows | Beta: written and unit-tested, not yet run on a real machine |
| Linux | Beta: same as Windows (needs a desktop session) |

Full requirements: [SPEC.md](SPEC.md). Notes for AI agents: [AGENTS.md](AGENTS.md) / [CLAUDE.md](CLAUDE.md).

## Setup

**You need:** Node 20+ (https://nodejs.org), Google Chrome, Telegram on your phone, and accounts on the job sites you use. Your resume and profile on each site should already be complete: the tool only applies, it never edits them.

### With Claude Code (recommended)

```bash
git clone <this repo> job-agent && cd job-agent
claude
> /setup
```

The `/setup` skill walks you through everything below. It asks your profile questions, then pauses while you paste your bot token, log in to the sites, and approve each site going live. It runs `npm run setup:check` after every step and stops at the first problem.

**Other AI agents (Codex, Cursor and others):** ask the agent to "follow `.claude/skills/setup/SKILL.md`". `AGENTS.md` points it there.

### By hand

1. `npm install`.
2. `cp config.example.yaml config.yaml` (on Windows: `copy`), then fill in every `TODO`. The agent refuses to run while any value is `TODO`, and lists them:
   - `profile`: name, contact, experience and skills, notice period, CTC (lakhs), degree, field of study, previous employers.
   - `templates`: your own Wellfound and Work at a Startup messages, using `{company}` and `{role}`.
   - `filters`: target title keywords, cities, `maxRequiredExperience`, and your current employer in `excludeCompanies`.
   - `sites`: `enabled` per site. Paste your Work at a Startup filtered URL. Leave `live: false` for now.
3. **Telegram:**
   - Create a bot with @BotFather (`/newbot`) and paste its token into `telegram.botToken`.
   - Send your bot any message, then run `npm run telegram -- --save` to fill in `chatId`.
   - Run `npm run telegram` again to get a test message.
4. **Agent Chrome:** `npm run chrome` opens Chrome on its own profile (`~/job-agent-chrome`, remote debugging on port 9333). Log into each site there once; the logins stay in that profile. Your normal Chrome is untouched.
5. **Check:** `npm run setup:check` shows ✅ or ❌ for each step, with the fix.
6. **Dry run, then go live:**
   - Run `npm run apply -- --site=naukri --dry-run --limit=3`. Nothing is submitted.
   - When the results look right, set that site's `live: true` and do a first real run with `--limit=2`.
7. **Schedule:** `npm run schedule:install` (times from `schedule.times`, default 08:00, 11:30, 15:00, 20:00).

### Before you share this project

Never share these. They hold personal data, and `.gitignore` already excludes them. If you share a zip instead of a git repo, delete them from the copy:

| File / folder | Contains |
|---|---|
| `config.yaml`, `config.yaml.bak` | Phone, email, CTC, Telegram bot token |
| `CLAUDE.local.md` | Your machine's status and notes |
| `data/` | Saved answers and application history |
| `logs/`, `reports/` | Screenshots and page snapshots from logged-in sessions |

Know these limits:

- **Account risk is yours.** LinkedIn's terms forbid automated applying and it can restrict accounts, so keep its cap low. Work at a Startup allows 5 applications per week.
- **Sites change their pages.** When one does, steps fail with "the page layout changed". Fix the selector as described in "Fixing a broken selector" below, or pull the latest version of the repo.
- **India-focused.** The answers and filters assume an Indian job search: CTC in lakhs, notice period, and Indian work authorisation.

## Commands

```bash
npm run chrome                          # open the agent Chrome (use this, not the Dock icon)
npm run apply -- --dry-run              # full run, no final submit, nothing recorded
npm run apply -- --site=naukri --limit=2
npm run apply                           # real run (only sites with live: true submit anything)
npm run review                          # answer queued screening questions; saved for future jobs
npm run telegram                        # send a test message (`-- --save` fills in your chat id)
npm run setup:check                     # every setup step: ✅ or ❌ with the fix
npm run inspect -- --site=<id> [--url=<url>]   # read-only list of buttons, links, inputs with suggested locators
npm run schedule:install                # daily runs at schedule.times (schedule:status / schedule:uninstall)
npm run typecheck && npm test
```

## Safety switches

- **`sites.<id>.live`** is `false` until you approve that site. A non-live site always runs as a dry run, even without `--dry-run`, so it never submits anything.
- **Daily caps** (`limits.dailyCap`) are shared across the four runs. The default delay between applications is a random 20–60 s.
- **Checkpoints:** a captcha, "verify you're human" screen or logout stops that site and sends a Telegram alert. The other sites continue.
- **Answers:** your saved answers, then `customAnswers`, then profile rules (then Ollama, if enabled and confident). If a required question has no answer, the form is abandoned and the job goes to Telegram. Guessed and `TODO` values are never submitted.
- **Hand-offs are final:** a job sent to Telegram is never retried, so you won't double-apply.

## Schedule

`npm run schedule:install` sets up daily runs at `schedule.times` (default 08:00, 11:30, 15:00 and 20:00) using your OS's scheduler. Re-run it after you change the times or upgrade Node.

| OS | Scheduler | Missed runs | Logs |
|---|---|---|---|
| macOS | launchd job `~/Library/LaunchAgents/com.jobagent.apply.plist` | Runs on wake | `logs/launchd.log` |
| Windows (beta) | Task Scheduler tasks "JobAgent HHMM", which run `data/scheduled-run.cmd` | Skipped | `logs/scheduled.log` |
| Linux (beta) | systemd user timer `~/.config/systemd/user/job-agent.timer` | Runs on next boot or wake | `logs/scheduled.log` |

On every OS the computer must be on and you must be logged in. Each run also writes `logs/run-YYYY-MM-DD.log`. On Linux, install from a terminal inside your desktop session, so the timer knows your display.

Runs happen **in the background**: if the agent Chrome isn't open, the run starts it without a window, and each site works in its own window behind whatever you're using. Chrome is started with flags that stop it from pausing hidden windows. On macOS this never takes focus; on Windows and Linux a window may briefly appear. If you opened the agent profile without remote debugging (for example from a desktop shortcut), the run can't attach and tells you on Telegram. Quit that window and use `npm run chrome`.

### Stopping it

| To | Do this |
|---|---|
| Stop all future runs | `npm run schedule:uninstall` (resume with `npm run schedule:install`) |
| Check whether it's scheduled | `npm run schedule:status` |
| Stop a run in progress | Ctrl-C if you started it in a terminal. A scheduled run: macOS/Linux `pkill -f src/cli/apply.ts`; Windows: end the `node.exe` task. The lock is released, so the next run isn't blocked |
| Pause one site | `sites.<site>.enabled: false` |
| Keep a site but never submit | `sites.<site>.live: false` |

## Sites

| Site | How it applies | Notes |
|---|---|---|
| Naukri | One click on Apply, then the recruiter questionnaire | Uses your Naukri profile resume |
| LinkedIn | Easy Apply, step by step; company-site jobs are sent to you with the direct link | Lowest daily cap (15) |
| Instahyre | One click on "Apply now" | |
| Wellfound | Apply dialog with your `templates.wellfound` note | |
| Work at a Startup | "Reach out" dialog with your `templates.workatastartup` message | YC allows 5 applications per week. When it's used up, the site pauses for 24 h and you get one note |

`limits.parallelSites: true` runs all sites at once in separate tabs (about 2–3 minutes instead of 10–15). Caps, delays and `--limit` still apply.

## Profile answers

Screening questions are answered only from facts in `config.yaml`: contact details, `totalExperienceYears`, `skillYears`, notice period, CTC (in lakhs, or full rupees when a field only takes numbers), `highestDegree`, `fieldOfStudy` (a ranked list, because sites name it differently), `previousEmployers`, relocation and on-site. Anything else goes to `npm run review` and Telegram. Add regex shortcuts in `customAnswers`.

## Telegram

- One message per job you need to handle: apply on the company site, answer its questions, or check a failure.
- A short summary after any run that did something or hit a problem (logout, captcha, crash).
- A whole-day summary from the first run after `telegram.dailySummaryAfter` (default 19:30), every day, so you know it ran.

## Fixing a broken selector

1. Look at `logs/failures/<date>/<site>-<jobId>.png` and `.html`, then `logs/run-<date>.log`.
2. `npm run inspect -- --site=<id> --url=<job url>` lists the page's buttons, links and inputs with suggested Playwright locators. It's read-only.
3. Update the named constant at the top of `src/adapters/<site>.ts`. Prefer `getByRole` with a name, then stable ids or data attributes, then `[class*="..."]`.
4. Verify with `npm run apply -- --site=<id> --dry-run --limit=3`.

Never use `force: true` to click inside a form: a forced click lands on whatever is drawn at that spot, which can be the Next or Submit button.

## Files

`data/jobs.db` (state), `logs/` (run logs, failure snapshots), `reports/YYYY-MM-DD.md` (daily report) and `config.yaml` are local only and gitignored.
