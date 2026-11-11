# Install job-bot on macOS

This guide takes a Mac (Apple silicon or Intel, macOS 13 or newer) from nothing to a working job-bot: the bot, the dashboard, the daily run and the Chrome extension. Run every command in **Terminal** (zsh, the default shell). Expect 30 to 45 minutes, most of it filling in your CV.

Other systems: [Linux](linux.md) · [Windows](windows.md) · [Start page](../README.md)

Paths below use `~/job-bot` for the project folder and `<you>` for your macOS user name (`whoami` prints it).

## Steps

1. [Install Homebrew and Node.js](#1-install-homebrew-and-nodejs)
2. [Install PostgreSQL and create the database](#2-install-postgresql-and-create-the-database)
3. [Get the code and install its packages](#3-get-the-code-and-install-its-packages)
4. [Create the env files](#4-create-the-env-files)
5. [Install the PDF renderer](#5-install-the-pdf-renderer)
6. [Choose the AI](#6-choose-the-ai)
7. [Put in your CV](#7-put-in-your-cv)
8. [Run the setup wizard](#8-run-the-setup-wizard)
9. [Review the search settings](#9-review-the-search-settings)
10. [Build your CV PDF](#10-build-your-cv-pdf)
11. [First fetch and the dashboard](#11-first-fetch-and-the-dashboard)
12. [Schedule the daily run](#12-schedule-the-daily-run)
13. [Notifications](#13-notifications)
14. [The Chrome extension](#14-the-chrome-extension)
15. [Check that it works](#15-check-that-it-works)

## 1. Install Homebrew and Node.js

job-bot needs **Node.js 24 or newer** (it runs its TypeScript directly, with no build step). This guide assumes Git is already installed (`git --version` works). If you do not have [Homebrew](https://brew.sh) yet, install it first and follow the "Next steps" it prints (they add `brew` to your PATH):

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Then:

```bash
brew install node
```

Use the plain `node` formula, not `node@24`: `node@24` is "keg-only" and is not put in `/opt/homebrew/bin`, where the daily run looks for Node (step 12). Node from nvm or fnm works for the commands in this guide, but the daily run will not find it unless you link it (step 12 says how).

**Success:**

```bash
node --version   # v24.0.0 or newer
```

## 2. Install PostgreSQL and create the database

job-bot keeps everything in one local PostgreSQL database called `job_bot` (PostgreSQL 15 or newer). Choose one of the two ways below. Both end with a `postgres` user without a password on `127.0.0.1`, which is what the connection string in step 4 uses.

### Option A: DBngin (a free menu-bar app)

1. Download and install [DBngin](https://dbngin.com).
2. Create a **PostgreSQL** server, version 15 or newer, on port `5432`, and start it. Its superuser is `postgres` with no password.
3. Its command-line tools are not on your PATH. Add them for this Terminal window (replace `17.x` with the version folder you see):

   ```bash
   ls /Users/Shared/DBngin/postgresql/
   export PATH="/Users/Shared/DBngin/postgresql/17.x/bin:$PATH"
   ```

### Option B: Homebrew

```bash
brew install postgresql@17
brew services start postgresql@17
echo 'export PATH="$(brew --prefix postgresql@17)/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
createuser -s postgres
```

Homebrew's PostgreSQL makes your macOS user its superuser; `createuser -s postgres` adds the `postgres` user the examples (and the test-database script) use.

### Create the database

You can skip this: the setup wizard (step 8) offers to create the database when it does not exist. By hand:

```bash
createdb -h 127.0.0.1 -U postgres job_bot
```

You do not create any tables: the bot creates and updates them itself (step 10).

**Success:**

```bash
psql -h 127.0.0.1 -U postgres -d job_bot -c "SELECT version();"   # prints "PostgreSQL 17..." (or your version)
```

The daily backup finds `pg_dump` by itself in DBngin's, Postgres.app's and Homebrew's folders, so it does not need to be on the PATH; `bot restore` finds `psql` the same way.

## 3. Get the code and install its packages

Keep the project **outside `~/Desktop`, `~/Documents` and `~/Downloads`**: macOS privacy protection does not let a background job (the daily run) read those folders.

```bash
git clone https://github.com/abdulrehmandar2234/job-bot.git ~/job-bot
cd ~/job-bot
npm install                 # the bot; also sets up the git pre-commit hook
npm --prefix web install    # the dashboard (it has its own package.json)
```

All later commands run in `~/job-bot`.

**Success:** both installs end with `added N packages` and no `ERR!` lines.

## 4. Create the env files

The bot reads `.env` in the project folder, the dashboard reads `web/.env.local`. Both need the database's connection string:

If you skip this, the setup wizard (step 8) offers to create the missing `.env` (from `.env.example`) and `web/.env.local` with your `DATABASE_URL`; the commands below are the manual way.

```bash
cp .env.example .env
echo 'DATABASE_URL=postgres://postgres@127.0.0.1:5432/job_bot' >> .env
echo 'DATABASE_URL=postgres://postgres@127.0.0.1:5432/job_bot' > web/.env.local
```

Both files are gitignored. Every other variable is optional; [configuration.md](../configuration.md#environment-variables) lists them all.

**Success:** `cat .env web/.env.local` shows the `DATABASE_URL` line in both.

## 5. Install the PDF renderer

CVs and cover letters are printed to PDF by Chrome's headless shell, installed once through Playwright:

```bash
npx playwright-core install chromium-headless-shell
```

It goes to `~/Library/Caches/ms-playwright/`. Without it, an installed Google Chrome or Chromium in `/Applications` is used instead.

**Success:** the download finishes without an error, and `ls ~/Library/Caches/ms-playwright` shows a `chromium_headless_shell-<number>` folder. Step 7 prints a first PDF with it.

## 6. Choose the AI

The AI reviews each job against your CV and writes letters, CV summaries and form answers. Pick one ([ai.md](../ai.md) compares them):

**A. The Claude Code CLI (the default, no API key).** It uses your Claude plan. Install it, start it once and sign in:

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude              # sign in in the browser window it opens, then type /exit
which claude        # usually /Users/<you>/.local/bin/claude
```

Note the path `which claude` prints: the setup wizard asks for it. Other ways to install are in the [Claude Code docs](https://docs.claude.com/en/docs/claude-code).

**B. One API key** (OpenAI, Anthropic, Gemini, Groq, OpenRouter, DeepSeek, Mistral, Together, or a local Ollama). Add the key to `.env` (open it in any editor, for example `open -e .env`):

```bash
AI_API_KEY=sk-ant-...
```

The key is read from `.env` only; never put it in `config.json`. In step 8 you answer `api`.

**C. No AI.** Possible, with fewer features: see [ai.md](../ai.md#running-without-ai).

**Success:** option A: `claude -p "say hi"` answers. Option B: the key is in `.env` (step 8 says whose key it looks like on the dashboard's Settings page later).

## 7. Put in your CV

`cv/master.json` is your CV as data. Every PDF, letter and AI prompt is built from it, and the bot never adds anything that is not in it. A fresh clone has none (it is gitignored, like everything personal). The setup wizard (step 8) offers to start it from the fictional example; or copy it yourself now and replace the example person with yourself:

```bash
cp cv/master.example.json cv/master.json
open -e cv/master.json      # or your own editor
```

Replace Jane Doe's name, contact, summary, skills, experience, projects and education with yours. Keep every field (use `[]` for no projects or education). [your-cv-and-profile.md](../your-cv-and-profile.md#your-cv-cvmasterjson) explains each field and how to write it so the keyword match finds your skills.

**Success:** the file is valid JSON and renders. This needs no database:

```bash
node -e "JSON.parse(require('fs').readFileSync('cv/master.json', 'utf8')); console.log('ok')"
npm run bot -- cv:preview classic --pdf     # PDF        : /Users/<you>/job-bot/data/previews/classic.pdf
open data/previews/classic.pdf
```

## 8. Run the setup wizard

```bash
npm run bot -- setup
```

It asks for your profile (name, contact, where you live, your country code and UTC offset, languages, work authorisation) and where you are looking (target countries and their visa route, remote work, LinkedIn locations, the AI, the CV file name). Every question shows the current value in `[brackets]`: **Enter keeps it, `-` clears it**. The name, email, phone and LinkedIn defaults come from `cv/master.json`.

Two answers to get right on a fresh clone:

- **Presets:** before the target countries it offers **market presets** (`gulf`, `netherlands`, `pakistan`: countries, LinkedIn locations and company boards), and after the LinkedIn locations **stack presets** (`php-laravel`, `javascript`, `python`: search keywords and job-title rules). Type one or more, comma-separated, or press Enter to keep what `config.json` has. See [configuration.md](../configuration.md#presets).
- **Target countries and "remote work from":** your `config.json` starts as a copy of `config.default.json`, which has the original owner's markets. The wizard proposes your own country for remote work and shows what the file had.
- **AI:** answer `claude-cli` and paste the `which claude` path from step 6 (the default, `claude`, is found on your PATH or in `~/.local/bin`), or `api` and pick a provider (`auto` detects it from the key).

If `.env` or `web/.env.local` is missing, it first offers to write them with `DATABASE_URL` only: it asks before writing, never overwrites an existing file and never asks for or writes an API key (those go in `.env` yourself, see `.env.example`).

Nothing is written until both files pass validation and you answer `y` to `Save cv/applicant.json and config.json?`. Each question is explained in [your-cv-and-profile.md](../your-cv-and-profile.md#the-setup-wizard).

**Success:** it prints `Saved.` and the next steps, and:

```bash
npm run bot -- settings:check --kind config --file config.json          # {"ok":true}
npm run bot -- settings:check --kind applicant --file cv/applicant.json  # {"ok":true}
```

## 9. Review the search settings

Without presets, the wizard does not touch the rest of `config.json`, which is still aimed at the owner's stack and markets. With presets, check that they fit you. Open it and review at least:

- `companies`: the company career boards to fetch (the defaults are UAE, Saudi, Dutch and Pakistani employers). `npm run bot -- discover <company names> --add` finds a company's board and adds it.
- `roleInclude` / `roleExclude`: which job titles pass. The default `roleExclude` drops Python (unless you chose the `python` stack), Java, Go, mobile, QA, DevOps and management titles: rewrite it for your stack.
- `linkedin.keywords` and `remote.himalayasQueries`: the search terms.

[configuration.md](../configuration.md) explains every key, with sensible values. Check the file again afterwards with `npm run bot -- settings:check --kind config --file config.json`.

## 10. Build your CV PDF

```bash
npm run bot -- cv:default
```

This is the first command that uses the database: it creates the tables first (from `src/migrations/`), then renders `cv/default/<your cvFileName>`.

**Success:** `default CV rebuilt from master.json → /Users/<you>/job-bot/cv/default/<cvFileName>`. Open it and check it.

Keep `"autoCvVersions": false` in `config.json` for now: the per-stack CV versions are written for the owner's CV ([why](../your-cv-and-profile.md#cv-versions-and-the-per-stack-framings)).

## 11. First fetch and the dashboard

```bash
npm run bot -- sponsors:update   # only if a target country uses "ind-register" (the Netherlands)
npm run bot -- fetch             # every source, a few minutes
npm run bot -- ai:score          # AI review of the new matches (up to ai.maxScorePerRun)
npm run web                      # the dashboard on http://localhost:3100
```

`fetch` prints one line per source (`✓ <company>: 12 postings`, `✗ <source>: <error>`) and ends with `N postings checked, M new. K matching jobs waiting (status=new).` `ai:score` ends with `N jobs scored.`

Open <http://localhost:3100>. Leave the Terminal window with `npm run web` open: the dashboard stops when you close it (Ctrl+C stops it on purpose). It only answers on this computer and has no login, so never expose it.

**Success:** the dashboard shows your target markets under the title, the **Matching** tab lists jobs, and no "Set up your profile" banner is shown. Few or no matches? Look at the **Filtered out** tab first ([troubleshooting.md](../troubleshooting.md#no-jobs-match)).

[daily-use.md](../daily-use.md) walks through the dashboard.

## 12. Schedule the daily run

`npm run bot -- daily` is the morning run: fetch, check which postings have closed, AI review, a notification, a database backup and a cleanup of leftover files, logged to `data/fetch.log`. On macOS, launchd starts it at 9:00 through `scripts/daily-fetch.sh`, a small wrapper that gives launchd a PATH.

Print the setup for this clone, with your paths filled in:

```bash
npm run bot -- schedule:print
```

It prints a plist like this one (shown for a user `<you>` with the project in `~/job-bot`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.<you>.job-bot.fetch</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>/Users/<you>/job-bot/scripts/daily-fetch.sh</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardErrorPath</key><string>/Users/<you>/job-bot/data/launchd.err.log</string>
</dict>
</plist>
```

Save the printed plist as `~/Library/LaunchAgents/com.<you>.job-bot.fetch.plist`, then load it and run it once now:

```bash
mkdir -p ~/job-bot/data
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.<you>.job-bot.fetch.plist
launchctl kickstart gui/$(id -u)/com.<you>.job-bot.fetch
tail -f ~/job-bot/data/fetch.log      # Ctrl+C to stop watching
```

Turn it off with `launchctl bootout gui/$(id -u)/com.<you>.job-bot.fetch`.

- **Node on the PATH:** the wrapper uses `PATH=~/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`. Homebrew's `node` is there. A Node from nvm or fnm is not: link it with `sudo ln -sf "$(which node)" /usr/local/bin/node` (again after changing Node versions). Without `node`, the wrapper writes `node not found on PATH` to `data/fetch.log` and shows a notification.
- **Sleep and shut-down:** if the Mac is asleep at 9:00, the run happens when it wakes. If it is shut down, that day's run is skipped; run `npm run bot -- daily` by hand, or see [troubleshooting.md](../troubleshooting.md#the-900-run-did-not-happen) for running it at login too.
- Only one fetch runs at a time: if **Fetch new jobs** is running on the dashboard, the daily fetch is skipped.

**Success:** after `kickstart`, `data/fetch.log` gets a `===== <date> =====` block with the fetch output and a `notification:` line, and a notification appears.

## 13. Notifications

job-bot shows a notification when the AI rates a job `strong` (once per job, grouped above three) and after each daily run. On macOS it uses `osascript`, built in. For notifications that open the job on the dashboard when clicked, install terminal-notifier (the bot uses it when it is in `/opt/homebrew/bin` or `/usr/local/bin`):

```bash
brew install terminal-notifier
```

Try it with job-bot's own notifier (terminal-notifier if installed, else osascript):

```bash
node --no-warnings -e "import('./src/notify.ts').then((m) => m.notify({ title: 'Job Bot', message: 'Test', url: 'http://localhost:3100' }))"
```

If nothing appears, allow notifications for **Script Editor** (osascript) or **terminal-notifier** in System Settings → Notifications, and check Focus / Do Not Disturb. To turn job-bot's notifications off, add `JOB_BOT_NOTIFY=off` to `.env`; for strong matches only, set `config.json` → `ai.alertStrong` to `false`.

**Success:** a "Job Bot: Test" notification appears (a failure prints `notification failed: ...`).

## 14. The Chrome extension

The extension sends the job you are looking at to job-bot, and shows the prepared CV, letter and answers in a side panel while you apply. **Fill this form** types them into the form's empty fields; it never overwrites a field, never clicks a button and never submits.

1. Keep the dashboard running (`npm run web`).
2. Open `chrome://extensions` in Chrome and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `extension` folder inside `~/job-bot` (in the file dialog, Cmd+Shift+G and type `~/job-bot/extension`).
4. Pin the job-bot button to the toolbar (puzzle icon → pin).

It talks only to your local dashboard, `http://localhost:3100` by default; if you run the dashboard on another port, set its address in the extension's options (**Extension options** in the popup). Details and permissions: [extension/README.md](https://github.com/abdulrehmandar2234/job-bot/blob/main/extension/README.md#dashboard-address-options).

**Success:** on any job page, the job-bot button opens a popup with the job's title and company read from the page.

## 15. Check that it works

`npm run bot -- doctor` checks most of this at once (Node, packages, settings, your CV and profile, the database, the PDF renderer and the AI) and prints how to fix each problem; it changes nothing.

- [ ] `node --version` is v24 or newer.
- [ ] `psql -h 127.0.0.1 -U postgres -d job_bot -c "SELECT 1;"` answers.
- [ ] `npm run bot -- settings:check --kind config --file config.json` prints `{"ok":true}`.
- [ ] `npm run bot -- cv:default` writes your CV, and the PDF looks right.
- [ ] `npm run bot -- stats` prints job counts.
- [ ] `npm run bot -- ai:score --limit 1` ends with `1 jobs scored.` (or `Nothing to score.` when every match is reviewed).
- [ ] <http://localhost:3100> shows jobs, and no profile banner.
- [ ] On a job page of the dashboard, **Prepare CV** and **Write letter** finish without an error.
- [ ] `launchctl print gui/$(id -u)/com.<you>.job-bot.fetch` shows the job, and `data/fetch.log` has a run.
- [ ] A notification appeared after the test run.
- [ ] The extension's popup reads a job page.

Next: [daily-use.md](../daily-use.md) for the everyday workflow, [updating.md](../updating.md) when a new version comes out, and [troubleshooting.md](../troubleshooting.md) if something is off.
