---
name: setup
description: Set up job-agent for a new user on macOS, Windows or Linux, step by step. Checks the machine, builds config.yaml from the user's answers, connects their own Telegram bot, opens the agent Chrome for them to log in, dry-runs each site, turns on the sites they approve and installs the daily schedule. Use when the user says "set this up", "/setup", "install", "onboard me", or setup:check shows problems.
---

# Set up job-agent

You are onboarding someone who wants this tool to apply to jobs for them. Work through the stages below in order. Every stage ends by running `npm run setup:check`, which is the source of truth: it prints ✅/❌ per step with the fix. Don't skip ahead past a ❌ unless the user asks to.

Read `AGENTS.md`/`CLAUDE.md` (hard rules) before starting. They apply throughout.

## Rules for this skill

- **Secrets stay in files.** Ask the user to paste the Telegram bot token into `config.yaml` themselves. Don't ask for it in chat. Never print or repeat `config.yaml` values (token, phone, email, CTC) back to the user, in commands, or in summaries; say "set" or "missing".
- **The user logs in, you don't.** Never type passwords, never create accounts, never solve captchas. Open the browser and wait.
- **Nothing goes live without the user saying so.** Every site starts with `live: false`. Set `live: true` for a site only after the user has seen its dry run and says "go live for <site>" (or clearly the same thing).
- **Don't guess profile facts.** If the user doesn't know an answer (e.g. years with a skill), leave it out or ask again. Never invent experience, CTC or notice period.
- **Don't overwrite.** If `config.yaml` already exists, keep it and only fill what `setup:check` reports as missing.
- Ask questions in small groups (3–5 at a time), using a multiple-choice question tool when you have one. Keep every message short.

## Stage 0: Check the machine

1. Run `npm run setup:check -- --no-logins`. If `npm` itself is missing, tell the user to install Node 20+ from https://nodejs.org and reopen the terminal.
2. Tell the user their OS and support level from the first line:
   - **macOS:** supported.
   - **Windows / Linux:** beta. Say plainly that the scheduler and Chrome launching on this OS are unit-tested but haven't been run on a real machine yet, so they should watch the first scheduled runs and `logs/`.
3. If dependencies are ❌, run `npm install`.
   - **Windows:** if `better-sqlite3` fails to build, the user needs "Desktop development with C++" from Visual Studio Build Tools, or a Node LTS version that has prebuilt binaries. Explain, then retry.
   - **Linux:** if the build fails, the user needs `build-essential` and `python3`.
4. If Chrome is ❌, ask the user to install Google Chrome (not Chromium) and re-run the check. If it's installed somewhere unusual, set `chrome.executablePath`.

## Stage 1: Build config.yaml

If `config.yaml` doesn't exist, copy `config.example.yaml` to `config.yaml` (keep the comments). Then ask the user and fill in each `TODO` with the Edit tool. Group the questions like this:

1. **About you:** first and last name, the email and phone number their job-site accounts use, country code, current city.
2. **Work:** current company and title, previous companies, total years of experience (decimal is fine, e.g. 3.5), years per main skill (whole numbers; add or remove skills in `skillYears` to match them).
3. **Offer:** notice period in days, current and expected CTC in lakhs per annum, open to relocation?, OK with on-site/hybrid?
4. **Education:** highest degree, field of study (store a few accepted spellings, e.g. `[Computer Science, Computer Science and Engineering]`), graduation year. LinkedIn/GitHub/portfolio URLs are optional.
5. **Targets:**
   - Which roles? Adjust `filters.includeTitleKeywords` / `excludeTitleKeywords`. The defaults suit frontend/full-stack SDE 1–2; rewrite them for other roles.
   - Which cities? Set `filters.locations`, lower case, and add `remote` if they want remote jobs.
   - What is the most experience a job may ask for? Set `filters.maxRequiredExperience`; typically 1–2 years above theirs.
   - Add their current employer to `filters.excludeCompanies`.
6. **Sites:**
   - Which of LinkedIn, Naukri, Instahyre, Wellfound, Work at a Startup do they use? Set `enabled` for each; disabled sites need nothing else.
   - **Work at a Startup:** they should paste the URL of their filtered search into `discoveryUrls`.
   - **LinkedIn:** mention that LinkedIn's terms forbid automated applying, and accounts can be restricted. Keep its cap low, or skip it.
7. **Messages:** only for enabled Wellfound / Work at a Startup.
   - Draft `templates.wellfound` (the answer to "What interests you about working for this company?") and `templates.workatastartup` (a note to the founder) from their profile.
   - Use 2–4 sentences, under 600 characters, and use `{company}` and `{role}`. Use only facts they gave you.
   - Show the drafts and get their OK or edits before saving.
8. **Schedule:** default run times are 08:00, 11:30, 15:00 and 20:00 local time (`schedule.times`). Ask if they want different times, keeping runs at least 3 hours apart.

Run `npm run setup:check -- --no-logins`. The config line should be ✅, apart from Telegram.

## Stage 2: Telegram (their own bot)

1. Tell the user to do the following in Telegram:
   - open @BotFather, send `/newbot`, and pick a name and a username ending in `bot`;
   - copy the token it gives;
   - paste it into `config.yaml` → `telegram.botToken` themselves, then say "done".
2. Run `npm run setup:check -- --no-logins`. If the token is ❌, the message says whether it was rejected (copy it again) or Telegram couldn't be reached (network/VPN).
3. Tell them to open their new bot in Telegram, press Start, and send it any message.
4. Run `npm run telegram -- --save`. It writes their chat id into `config.yaml` when exactly one person messaged the bot. If it lists several chats, ask which one is theirs (by name, not by id) and set `telegram.chatId` to it.
5. Run `npm run telegram` to send a test message, and ask them to confirm it arrived.

## Stage 3: Agent Chrome and logins

1. Run `npm run chrome`. It opens a separate Chrome profile (`~/job-agent-chrome`) with all five job sites.
2. Explain:
   - this window is only for the agent;
   - their normal Chrome is untouched;
   - they should log into each enabled site in it, once, with their own account;
   - they should say "done" when finished.
3. If the check says the profile is open without remote debugging, they opened it another way. Ask them to quit that Chrome window, then run `npm run chrome` again.
4. Run `npm run setup:check`, this time with logins (it takes about 20 s). Repeat until every enabled site shows "logged in". For a captcha ❌, the user clears it themselves in that window.

## Stage 4: Dry runs (nothing is submitted)

For each enabled site, one at a time:

1. Run `npm run apply -- --site=<id> --dry-run --limit=3`. It can take a few minutes. Chrome works in background windows, so the user can keep working.
2. Summarise the output in a few lines: jobs found, what it would apply to, what it skipped and why, and anything that went to Telegram.
3. Ask if the results look right. If the jobs are wrong, tune the filters and run again.
4. Explain that hand-offs are jobs it can't apply to itself. They go to Telegram with the reason.
5. Ask whether to go live for this site.

Only when they say yes, set `sites.<id>.live: true`. Suggest a first live run with `npm run apply -- --site=<id> --limit=2`, and offer to run it.

If a site fails with "the page layout changed", the site may have been redesigned since the selectors were written. Follow "Fixing a broken selector" in the README, or tell the user to report it to whoever shared the repo.

## Stage 5: Schedule

1. Run `npm run schedule:install`.
   - **Linux:** it must be run from a terminal inside their desktop session (it records `DISPLAY` for Chrome). If it warns about a missing display, ask them to run `npm run schedule:install` from their desktop terminal.
2. Run `npm run setup:check` one last time. Everything should be ✅.
3. Finish with a short summary:
   - which sites are live, and when it runs;
   - what arrives on Telegram (hand-offs, a summary after busy runs, a daily summary in the evening, logout or captcha alerts);
   - `npm run review` answers questions it couldn't, and the answers are reused.
4. Tell them how to stop it:
   - `npm run schedule:uninstall` stops future runs, and `npm run schedule:install` resumes them;
   - Ctrl-C stops a run started by hand;
   - `sites.<id>.enabled: false` pauses one site, and `live: false` makes it dry-run only.
5. Remind them that it runs only while the computer is on and they're logged in, and that the agent Chrome must stay logged in. A logout triggers a Telegram alert.

## Resuming

If the user comes back later or something broke, run `npm run setup:check` and continue from the first ❌.
