# Install Talaash on Windows

This guide takes a Windows 10 or 11 PC from nothing to a working Talaash: the bot, the dashboard, the daily run and the Chrome extension. Run every command in **PowerShell** (Start menu → "PowerShell"; not "Command Prompt", unless a step says so). Expect 30 to 45 minutes, most of it filling in your CV.

Other systems: [macOS](macos.md) · [Linux](linux.md) · [Start page](../README.md)

Paths below use `$HOME\talaash` (that is `C:\Users\<you>\talaash`) for the project folder, where `<you>` is your Windows user name (`$env:USERNAME` prints it).

## Steps

1. [Install Node.js and PostgreSQL](#1-install-nodejs-and-postgresql)
2. [Create the database](#2-create-the-database)
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

## 1. Install Node.js and PostgreSQL

Talaash needs **Node.js 24 or newer** (it runs its TypeScript directly, with no build step) and **PostgreSQL 15 or newer**. This guide assumes Git is already installed (`git --version` works). With winget (built into Windows 10 and 11):

```powershell
winget install OpenJS.NodeJS.LTS
winget install --interactive PostgreSQL.PostgreSQL.17
```

`--interactive` shows the PostgreSQL installer, so you can **choose the password of the `postgres` user**: write it down, you need it in step 2 and 4. Keep the port `5432`. Stack Builder at the end is not needed. Without winget, use the installers from [nodejs.org](https://nodejs.org) and [postgresql.org](https://www.postgresql.org/download/windows/).

**Close PowerShell and open a new window**, so it sees the new PATH.

If `npm` then fails with "running scripts is disabled on this system", PowerShell's execution policy blocks npm's PowerShell wrapper. Either allow signed and local scripts for your user:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

or type `npm.cmd` wherever this guide says `npm`.

**Success:**

```powershell
node --version   # v24.0.0 or newer
npm --version
```

## 2. Create the database

Talaash keeps everything in one local PostgreSQL database called `job_bot`. The PostgreSQL tools are not on the PATH; add them for this window (change `17` if you installed another version):

```powershell
$env:Path += ';C:\Program Files\PostgreSQL\17\bin'
createdb -h 127.0.0.1 -U postgres job_bot      # asks for the postgres password from step 1
```

(Or skip it: the setup wizard, step 8, offers to create the database when it does not exist.)

Your connection string is then (with that password):

```
postgres://postgres:<password>@127.0.0.1:5432/job_bot
```

If the password has characters other than letters and digits, percent-encode them in the connection string (`@` is `%40`, `/` is `%2F`, `:` is `%3A`, `#` is `%23`). You do not create any tables: the bot creates and updates them itself (step 10).

**Success:**

```powershell
psql -h 127.0.0.1 -U postgres -d job_bot -c "SELECT version();"   # prints "PostgreSQL 17..." after the password
```

The daily backup finds `pg_dump.exe` in `C:\Program Files\PostgreSQL\<version>\bin` by itself, so it does not need to be on the PATH; `bot restore` finds `psql.exe` the same way.

## 3. Get the code and install its packages

```powershell
git clone https://github.com/abdulrehmandar2234/talaash.git $HOME\talaash
cd $HOME\talaash
npm install                 # the bot; also sets up the git pre-commit hook
npm --prefix web install    # the dashboard (it has its own package.json)
```

All later commands run in `$HOME\talaash`. The repository keeps LF line endings on every OS (`.gitattributes`), so Git's `core.autocrlf` setting does not matter.

**Success:** both installs end with `added N packages` and no `ERR!` lines.

## 4. Create the env files

The bot reads `.env` in the project folder, the dashboard reads `web\.env.local`. Both need the connection string from step 2 (replace `<password>`):

If you skip this, the setup wizard (step 8) offers to create the missing `.env` (from `.env.example`) and `web\.env.local` with your `DATABASE_URL`; the commands below are the manual way.

```powershell
Copy-Item .env.example .env
Add-Content .env 'DATABASE_URL=postgres://postgres:<password>@127.0.0.1:5432/job_bot'
Set-Content web\.env.local 'DATABASE_URL=postgres://postgres:<password>@127.0.0.1:5432/job_bot'
```

Both files are gitignored. The daily backup uses the same connection string, password included. Every other variable is optional; [configuration.md](../configuration.md#environment-variables) lists them all.

**Success:** `Get-Content .env, web\.env.local` shows the `DATABASE_URL` line in both.

## 5. Install the PDF renderer

CVs and cover letters are printed to PDF by Chrome's headless shell, installed once through Playwright:

```powershell
npx playwright-core install chromium-headless-shell
```

It goes to `%LOCALAPPDATA%\ms-playwright\`. Without it, an installed Google Chrome (`C:\Program Files\Google\Chrome\Application\chrome.exe`, or the `(x86)` folder) is used instead.

**Success:** the download finishes without an error, and `Get-ChildItem $env:LOCALAPPDATA\ms-playwright` shows a `chromium_headless_shell-<number>` folder. Step 7 prints a first PDF with it.

## 6. Choose the AI

The AI reviews each job against your CV and writes letters, CV summaries and form answers. Pick one ([ai.md](../ai.md) compares them):

**A. The Claude Code CLI (the default, no API key).** It uses your Claude plan. Install it with the native installer, start it once and sign in:

```powershell
irm https://claude.ai/install.ps1 | iex
claude                       # sign in in the browser window it opens, then type /exit
where.exe claude             # usually C:\Users\<you>\.local\bin\claude.exe
```

Note the `claude.exe` path: the setup wizard asks for it. Use the native installer's `claude.exe`, not a `claude.cmd` from `npm install -g`: the bot starts programs without a shell, and a `.cmd` file cannot be started that way. In PowerShell, type `where.exe`, not `where` (which is a different PowerShell command). Other ways to install are in the [Claude Code docs](https://docs.claude.com/en/docs/claude-code).

**B. One API key** (OpenAI, Anthropic, Gemini, Groq, OpenRouter, DeepSeek, Mistral, Together, or a local Ollama). Add the key to `.env` (for example `notepad .env`):

```
AI_API_KEY=sk-ant-...
```

The key is read from `.env` only; never put it in `config.json`. In step 8 you answer `api`.

**C. No AI.** Possible, with fewer features: see [ai.md](../ai.md#running-without-ai).

**Success:** option A: `claude -p "say hi"` answers. Option B: the key is in `.env`.

## 7. Put in your CV

`cv\master.json` is your CV as data. Every PDF, letter and AI prompt is built from it, and the bot never adds anything that is not in it. A fresh clone has none (it is gitignored, like everything personal). The setup wizard (step 8) offers to start it from the fictional example; or copy it yourself now and replace the example person with yourself:

```powershell
Copy-Item cv\master.example.json cv\master.json -Force
notepad cv\master.json       # or your own editor
```

Replace Jane Doe's name, contact, summary, skills, experience, projects and education with yours. Keep every field (use `[]` for no projects or education). [your-cv-and-profile.md](../your-cv-and-profile.md#your-cv-cvmasterjson) explains each field and how to write it so the keyword match finds your skills. Save the file as UTF-8 (Notepad's default).

**Success:** the file is valid JSON and renders. This needs no database:

```powershell
node -e "JSON.parse(require('fs').readFileSync('cv/master.json', 'utf8')); console.log('ok')"
npm run bot -- cv:preview classic --pdf     # PDF        : C:\Users\<you>\talaash\data\previews/classic.pdf
Invoke-Item data\previews\classic.pdf
```

## 8. Run the setup wizard

```powershell
npm run bot -- setup
```

It asks for your profile (name, contact, where you live, your country code and UTC offset, languages, work authorisation) and where you are looking (target countries and their visa route, remote work, LinkedIn locations, the AI, the CV file name). Every question shows the current value in `[brackets]`: **Enter keeps it, `-` clears it**. The name, email, phone and LinkedIn defaults come from `cv\master.json`.

Two answers to get right on a fresh clone:

- **Presets:** before the target countries it offers **market presets** (`gulf`, `netherlands`, `pakistan`: countries, LinkedIn locations and company boards), and after the LinkedIn locations **stack presets** (`php-laravel`, `javascript`, `python`: search keywords and job-title rules). Type one or more, comma-separated, or press Enter to keep what `config.json` has. See [configuration.md](../configuration.md#presets).
- **Target countries and "remote work from":** your `config.json` starts as a copy of `config.default.json`, which has the original owner's markets. The wizard proposes your own country for remote work and shows what the file had.
- **AI:** answer `claude-cli` and paste the `claude.exe` path from step 6 (the repository's path is the owner's, from a Mac; the wizard's hint says `where claude`, which in PowerShell must be typed `where.exe claude`), or `api` and pick a provider (`auto` detects it from the key).

If `.env` or `web\.env.local` is missing, it first offers to write them with `DATABASE_URL` only: it asks before writing, never overwrites an existing file and never asks for or writes an API key (those go in `.env` yourself, see `.env.example`).

Nothing is written until both files pass validation and you answer `y` to `Save cv/applicant.json and config.json?`. Each question is explained in [your-cv-and-profile.md](../your-cv-and-profile.md#the-setup-wizard).

**Success:** it prints `Saved.` and the next steps, and:

```powershell
npm run bot -- settings:check --kind config --file config.json          # {"ok":true}
npm run bot -- settings:check --kind applicant --file cv/applicant.json  # {"ok":true}
```

## 9. Review the search settings

Without presets, the wizard does not touch the rest of `config.json`, which is still aimed at the owner's stack and markets. With presets, check that they fit you. Open it (`notepad config.json`) and review at least:

- `companies`: the company career boards to fetch (the defaults are UAE, Saudi, Dutch and Pakistani employers). `npm run bot -- discover <company names> --add` finds a company's board and adds it.
- `roleInclude` / `roleExclude`: which job titles pass. The default `roleExclude` drops Python (unless you chose the `python` stack), Java, Go, mobile, QA, DevOps and management titles: rewrite it for your stack.
- `linkedin.keywords` and `remote.himalayasQueries`: the search terms.

[configuration.md](../configuration.md) explains every key, with sensible values. In JSON a backslash is written twice (`"C:\\Users\\<you>\\..."`; forward slashes work too). Check the file again afterwards with `npm run bot -- settings:check --kind config --file config.json`.

## 10. Build your CV PDF

```powershell
npm run bot -- cv:default
```

This is the first command that uses the database: it creates the tables first (from `src\migrations\`), then renders `cv\default\<your cvFileName>`.

**Success:** `default CV rebuilt from master.json → C:\Users\<you>\talaash\cv\default\<cvFileName>`. Open it and check it.

Keep `"autoCvVersions": false` in `config.json` for now: the per-stack CV versions are written for the owner's CV ([why](../your-cv-and-profile.md#cv-versions-and-the-per-stack-framings)).

## 11. First fetch and the dashboard

```powershell
npm run bot -- sponsors:update   # only if a target country uses "ind-register" (the Netherlands)
npm run bot -- fetch             # every source, a few minutes
npm run bot -- ai:score          # AI review of the new matches (up to ai.maxScorePerRun)
npm run web                      # the dashboard on http://localhost:3100
```

`fetch` prints one line per source (`✓ <company>: 12 postings`, `✗ <source>: <error>`) and ends with `N postings checked, M new. K matching jobs waiting (status=new).` `ai:score` ends with `N jobs scored.`

Open <http://localhost:3100>. Leave the PowerShell window with `npm run web` open: the dashboard stops when you close it (Ctrl+C stops it on purpose). It only answers on this computer and has no login, so never expose it. If Windows Firewall asks about Node.js, you can cancel: the dashboard does not need the network.

**Success:** the dashboard shows your target markets under the title, the **Matching** tab lists jobs, and no "Set up your profile" banner is shown. Few or no matches? Look at the **Filtered out** tab first ([troubleshooting.md](../troubleshooting.md#no-jobs-match)).

[daily-use.md](../daily-use.md) walks through the dashboard.

## 12. Schedule the daily run

`npm run bot -- daily` is the daily run: fetch, check which postings have closed, AI review, a notification, a database backup and a cleanup of leftover files, logged to `data\fetch.log`. It runs once a day at `dailyTime` in `config.json` (default `09:00`; the Settings page has it as **Daily run time**). On Windows, Task Scheduler starts it at that time, and `-StartWhenAvailable` runs a missed run as soon as the computer is on again. Print the setup for this clone, with your paths, your Node and your time filled in:

```powershell
npm run bot -- schedule:print
```

It prints lines like these (shown for `C:\Users\<you>\talaash`, Node in `C:\Program Files\nodejs` and the default 09:00). Paste the printed PowerShell lines into PowerShell:

```powershell
$action = New-ScheduledTaskAction -Execute 'C:\Program Files\nodejs\node.exe' -Argument '--no-warnings --env-file-if-exists=.env src/cli.ts daily' -WorkingDirectory 'C:\Users\<you>\talaash'
$trigger = New-ScheduledTaskTrigger -Daily -At '09:00'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName 'job-bot daily fetch' -Action $action -Trigger $trigger -Settings $settings -Force
Start-ScheduledTask -TaskName 'job-bot daily fetch'   # run it once now to try it
```

**Changing the time later:** set it on the Settings page (or `dailyTime` in `config.json`), then run `npm run bot -- schedule:print` again and paste its PowerShell lines again; `-Force` replaces the task. (Unlike macOS and Linux, the task is not started every 30 minutes, because Windows would open a console window each time.)

Watch the log:

```powershell
Get-Content $HOME\talaash\data\fetch.log -Wait     # Ctrl+C to stop watching
```

Or, in **Command Prompt** (`cmd.exe`) with `schtasks`, which does not catch up a missed run:

```bat
schtasks /Create /F /SC DAILY /ST 09:00 /TN "job-bot daily fetch" /TR "\"C:\Program Files\nodejs\node.exe\" --no-warnings \"C:\Users\<you>\talaash\src\cli.ts\" daily"
schtasks /Run /TN "job-bot daily fetch"
```

(`schtasks` cannot set a working folder; `bot daily` finds its folder and `.env` by itself.) Turn it off with `Unregister-ScheduledTask -TaskName 'job-bot daily fetch'` (or `schtasks /Delete /TN "job-bot daily fetch"`).

- The task runs only while you are logged in, so the notification can show. A console window is open while it runs (a minute or two): that is Task Scheduler starting `node.exe`.
- `bot daily` puts `%USERPROFILE%\.local\bin` (where the Claude CLI installs itself) first on the PATH of each step, so `claude.exe` there is found.
- Only one fetch runs at a time: if **Fetch new jobs** is running on the dashboard, the daily fetch is skipped.

**Success:** after `Start-ScheduledTask`, `data\fetch.log` gets a `===== <date> =====` block with the fetch output and a `notification:` line, and `Get-ScheduledTaskInfo -TaskName 'job-bot daily fetch'` shows `LastTaskResult : 0` once it has finished.

## 13. Notifications

Talaash shows a notification when the AI rates a job `strong` (once per job, grouped above three) and after each daily run. On Windows it shows a toast through the built-in Windows PowerShell (clicking it opens the dashboard), or a tray balloon if toasts are unavailable. Nothing to install. Try it:

```powershell
node --no-warnings -e "import('./src/notify.ts').then((m) => m.notify({ title: 'Talaash', message: 'Test', url: 'http://localhost:3100' }))"
```

If nothing appears, check Settings → System → Notifications: notifications must be on, **Windows PowerShell** must be allowed, and Focus assist / Do not disturb must be off. To turn Talaash's notifications off, add `JOB_BOT_NOTIFY=off` to `.env`; for strong matches only, set `config.json` → `ai.alertStrong` to `false`.

**Success:** a "Talaash: Test" toast appears (a failure prints `notification failed: ...`).

## 14. The Chrome extension

The extension sends the job you are looking at to Talaash, and shows the prepared CV, letter and answers in a side panel while you apply. **Fill this form** types them into the form's empty fields; it never overwrites a field, never clicks a button and never submits.

1. Keep the dashboard running (`npm run web`).
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `extension` folder inside `C:\Users\<you>\talaash`.
4. Pin the Talaash button to the toolbar (puzzle icon → pin).

It talks only to your local dashboard, `http://localhost:3100` by default; if you run the dashboard on another port, set its address in the extension's options (**Extension options** in the popup). Details and permissions: [extension/README.md](https://github.com/abdulrehmandar2234/talaash/blob/main/extension/README.md#dashboard-address-options).

**Success:** on any job page, the Talaash button opens a popup with the job's title and company read from the page.

## 15. Check that it works

`npm run bot -- doctor` checks most of this at once (Node, packages, settings, your CV and profile, the database, the PDF renderer and the AI) and prints how to fix each problem; it changes nothing.

- [ ] `node --version` is v24 or newer.
- [ ] `psql -h 127.0.0.1 -U postgres -d job_bot -c "SELECT 1;"` answers (with the PostgreSQL `bin` folder on the PATH, step 2).
- [ ] `npm run bot -- settings:check --kind config --file config.json` prints `{"ok":true}`.
- [ ] `npm run bot -- cv:default` writes your CV, and the PDF looks right.
- [ ] `npm run bot -- stats` prints job counts.
- [ ] `npm run bot -- ai:score --limit 1` ends with `1 jobs scored.` (or `Nothing to score.` when every match is reviewed).
- [ ] <http://localhost:3100> shows jobs, and no profile banner.
- [ ] On a job page of the dashboard, **Prepare CV** and **Write letter** finish without an error.
- [ ] Task Scheduler (`taskschd.msc`) lists **job-bot daily fetch**, and `data\fetch.log` has a run.
- [ ] `npm run bot -- backup` prints `backup: ...\data\backups\job_bot-<date>.sql.gz`.
- [ ] The test notification appeared.
- [ ] The extension's popup reads a job page.

Next: [daily-use.md](../daily-use.md) for the everyday workflow, [updating.md](../updating.md) when a new version comes out, and [troubleshooting.md](../troubleshooting.md#windows) if something is off.
