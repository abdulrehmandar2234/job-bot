# Install job-bot on Linux

This guide takes a Linux desktop from nothing to a working job-bot: the bot, the dashboard, the daily run and the Chrome extension. Commands are for **Ubuntu and Debian**; [Fedora and Arch](#fedora-and-arch) differ only in step 1 and 2, noted at the end. Run them in any terminal (bash). Expect 30 to 45 minutes, most of it filling in your CV.

Other systems: [macOS](macos.md) · [Windows](windows.md) · [Start page](../README.md)

Paths below use `~/job-bot` (that is `/home/<you>/job-bot`) for the project folder, where `<you>` is your user name (`whoami` prints it).

## Steps

1. [Install Node.js](#1-install-nodejs)
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

## 1. Install Node.js

job-bot needs **Node.js 24 or newer** (it runs its TypeScript directly, with no build step). This guide assumes Git is already installed (`git --version` works). The distribution's own `nodejs` package is usually older, so install Node 24 from NodeSource:

```bash
sudo apt-get update
sudo apt-get install -y curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
```

nvm or fnm work too. The daily run (step 12) then needs Node's full path, which `schedule:print` fills in for you.

**Success:**

```bash
node --version   # v24.0.0 or newer
```

## 2. Install PostgreSQL and create the database

job-bot keeps everything in one local PostgreSQL database called `job_bot` (PostgreSQL 15 or newer).

```bash
sudo apt-get install -y postgresql
psql --version
```

If `psql --version` is older than 15 (Ubuntu 22.04 ships 14), add the PostgreSQL project's own repository and install a current version:

```bash
sudo apt-get install -y postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh
sudo apt-get install -y postgresql-17
```

The packaged PostgreSQL starts by itself. job-bot connects over TCP (`127.0.0.1`), where the package asks for a **password**, so create a user with a password for job-bot, and a database it owns:

```bash
sudo -u postgres createuser --pwprompt jobbot     # type a password twice
sudo -u postgres createdb --owner=jobbot job_bot
```

Pick a password of letters and digits: it goes into a connection string, where other characters must be percent-encoded (`@` is `%40`, `/` is `%2F`, ...). A warning `could not change directory to "/home/<you>"` is harmless.

Your connection string is then (with your password):

```
postgres://jobbot:<password>@127.0.0.1:5432/job_bot
```

You do not create any tables: the bot creates and updates them itself (step 10).

**Success:**

```bash
psql "postgres://jobbot:<password>@127.0.0.1:5432/job_bot" -c "SELECT version();"   # prints "PostgreSQL 16..." (or your version)
```

## 3. Get the code and install its packages

```bash
git clone https://github.com/abdulrehmandar2234/job-bot.git ~/job-bot
cd ~/job-bot
npm install                 # the bot; also sets up the git pre-commit hook
npm --prefix web install    # the dashboard (it has its own package.json)
```

All later commands run in `~/job-bot`.

**Success:** both installs end with `added N packages` and no `ERR!` lines.

## 4. Create the env files

The bot reads `.env` in the project folder, the dashboard reads `web/.env.local`. Both need the connection string from step 2:

If you skip this, the setup wizard (step 8) offers to create the missing `.env` (from `.env.example`) and `web/.env.local` with your `DATABASE_URL`; the commands below are the manual way.

```bash
cp .env.example .env
echo 'DATABASE_URL=postgres://jobbot:<password>@127.0.0.1:5432/job_bot' >> .env
echo 'DATABASE_URL=postgres://jobbot:<password>@127.0.0.1:5432/job_bot' > web/.env.local
```

Replace `<password>` with yours. Both files are gitignored. The daily backup uses the same connection string, password included. Every other variable is optional; [configuration.md](../configuration.md#environment-variables) lists them all.

**Success:** `cat .env web/.env.local` shows the `DATABASE_URL` line in both.

## 5. Install the PDF renderer

CVs and cover letters are printed to PDF by Chrome's headless shell, installed once through Playwright:

```bash
npx playwright-core install chromium-headless-shell
```

It goes to `~/.cache/ms-playwright/`. Without it, an installed `google-chrome`, `google-chrome-stable`, `chromium` or `chromium-browser` in `/usr/bin` is used instead. On a minimal system, the shell may also need system libraries (Debian and Ubuntu):

```bash
npx playwright-core install-deps chromium-headless-shell
```

**Success:** the download finishes without an error, and `ls ~/.cache/ms-playwright` shows a `chromium_headless_shell-<number>` folder. Step 7 prints a first PDF with it.

## 6. Choose the AI

The AI reviews each job against your CV and writes letters, CV summaries and form answers. Pick one ([ai.md](../ai.md) compares them):

**A. The Claude Code CLI (the default, no API key).** It uses your Claude plan. Install it, start it once and sign in:

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude              # sign in through the link it shows, then type /exit
which claude        # usually /home/<you>/.local/bin/claude
```

Note the path `which claude` prints: the setup wizard asks for it. Other ways to install are in the [Claude Code docs](https://docs.claude.com/en/docs/claude-code).

**B. One API key** (OpenAI, Anthropic, Gemini, Groq, OpenRouter, DeepSeek, Mistral, Together, or a local Ollama). Add the key to `.env` (for example `nano .env`):

```bash
AI_API_KEY=sk-ant-...
```

The key is read from `.env` only; never put it in `config.json`. In step 8 you answer `api`.

**C. No AI.** Possible, with fewer features: see [ai.md](../ai.md#running-without-ai).

**Success:** option A: `claude -p "say hi"` answers. Option B: the key is in `.env`.

## 7. Put in your CV

`cv/master.json` is your CV as data. Every PDF, letter and AI prompt is built from it, and the bot never adds anything that is not in it. A fresh clone has none (it is gitignored, like everything personal). The setup wizard (step 8) offers to start it from the fictional example; or copy it yourself now and replace the example person with yourself:

```bash
cp cv/master.example.json cv/master.json
nano cv/master.json         # or your own editor
```

Replace Jane Doe's name, contact, summary, skills, experience, projects and education with yours. Keep every field (use `[]` for no projects or education). [your-cv-and-profile.md](../your-cv-and-profile.md#your-cv-cvmasterjson) explains each field and how to write it so the keyword match finds your skills.

**Success:** the file is valid JSON and renders. This needs no database:

```bash
node -e "JSON.parse(require('fs').readFileSync('cv/master.json', 'utf8')); console.log('ok')"
npm run bot -- cv:preview classic --pdf     # PDF        : /home/<you>/job-bot/data/previews/classic.pdf
xdg-open data/previews/classic.pdf
```

## 8. Run the setup wizard

```bash
npm run bot -- setup
```

It asks for your profile (name, contact, where you live, your country code and UTC offset, languages, work authorisation) and where you are looking (target countries and their visa route, remote work, LinkedIn locations, the AI, the CV file name). Every question shows the current value in `[brackets]`: **Enter keeps it, `-` clears it**. The name, email, phone and LinkedIn defaults come from `cv/master.json`.

Two answers to get right on a fresh clone:

- **Presets:** before the target countries it offers **market presets** (`gulf`, `netherlands`, `pakistan`: countries, LinkedIn locations and company boards), and after the LinkedIn locations **stack presets** (`php-laravel`, `javascript`, `python`: search keywords and job-title rules). Type one or more, comma-separated, or press Enter to keep what `config.json` has. See [configuration.md](../configuration.md#presets).
- **Target countries and "remote work from":** your `config.json` starts as a copy of `config.default.json`, which has the original owner's markets. The wizard proposes your own country for remote work and shows what the file had.
- **AI:** answer `claude-cli` and paste the `which claude` path from step 6 (the repository's path is the owner's, from a Mac), or `api` and pick a provider (`auto` detects it from the key).

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

**Success:** `default CV rebuilt from master.json → /home/<you>/job-bot/cv/default/<cvFileName>`. Open it and check it.

Keep `"autoCvVersions": false` in `config.json` for now: the per-stack CV versions are written for the owner's CV ([why](../your-cv-and-profile.md#cv-versions-and-the-per-stack-framings)).

## 11. First fetch and the dashboard

```bash
npm run bot -- sponsors:update   # only if a target country uses "ind-register" (the Netherlands)
npm run bot -- fetch             # every source, a few minutes
npm run bot -- ai:score          # AI review of the new matches (up to ai.maxScorePerRun)
npm run web                      # the dashboard on http://localhost:3100
```

`fetch` prints one line per source (`✓ <company>: 12 postings`, `✗ <source>: <error>`) and ends with `N postings checked, M new. K matching jobs waiting (status=new).` `ai:score` ends with `N jobs scored.`

Open <http://localhost:3100>. Leave the terminal with `npm run web` open: the dashboard stops when you close it (Ctrl+C stops it on purpose). It only answers on this computer and has no login, so never expose it.

**Success:** the dashboard shows your target markets under the title, the **Matching** tab lists jobs, and no "Set up your profile" banner is shown. Few or no matches? Look at the **Filtered out** tab first ([troubleshooting.md](../troubleshooting.md#no-jobs-match)).

[daily-use.md](../daily-use.md) walks through the dashboard.

## 12. Schedule the daily run

`npm run bot -- daily` is the morning run: fetch, check which postings have closed, AI review, a notification, a database backup and a cleanup of leftover files, logged to `data/fetch.log`. On Linux a **systemd user timer** starts it at 9:00, and with `Persistent=true` it also catches up a run missed while the computer was off. Print the setup for this clone, with your paths and your Node filled in:

```bash
npm run bot -- schedule:print
```

It prints two unit files (shown here for `/home/<you>/job-bot` and a Node in `/usr/bin/node`) and a cron alternative. Save the first as `~/.config/systemd/user/job-bot-fetch.service`:

```ini
[Unit]
Description=job-bot daily fetch

[Service]
Type=oneshot
WorkingDirectory=/home/<you>/job-bot
ExecStart="/usr/bin/node" --no-warnings --env-file-if-exists=.env src/cli.ts daily
```

and the second as `~/.config/systemd/user/job-bot-fetch.timer`:

```ini
[Unit]
Description=job-bot daily fetch at 9:00

[Timer]
OnCalendar=*-*-* 09:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

(`mkdir -p ~/.config/systemd/user` first if the folder does not exist.) Then enable it and run it once now:

```bash
systemctl --user daemon-reload && systemctl --user enable --now job-bot-fetch.timer
systemctl --user start job-bot-fetch.service      # run it once now
systemctl --user list-timers job-bot-fetch.timer  # the next run
tail -f ~/job-bot/data/fetch.log                  # Ctrl+C to stop watching
```

Turn it off with `systemctl --user disable --now job-bot-fetch.timer`.

- **Logged out:** user timers run while you are logged in. To run them without a login session too: `sudo loginctl enable-linger $USER`.
- **Node path:** with nvm or fnm, `ExecStart` points into one Node version's folder. After changing Node versions, run `schedule:print` again and update the unit.
- `bot daily` puts `~/.local/bin` (where the Claude CLI installs itself) first on the PATH of each step, so a `claude` there is found.
- Only one fetch runs at a time: if **Fetch new jobs** is running on the dashboard, the daily fetch is skipped.

**Or cron** (`crontab -e`). Cron skips a run missed while the computer was off, and needs your session bus address for desktop notifications (`id -u` gives the number; `schedule:print` fills it in):

```bash
DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
0 9 * * * cd '/home/<you>/job-bot' && '/usr/bin/node' --no-warnings --env-file-if-exists=.env src/cli.ts daily
```

**Success:** after `systemctl --user start job-bot-fetch.service`, `data/fetch.log` gets a `===== <date> =====` block with the fetch output and a `notification:` line, and `systemctl --user status job-bot-fetch.service` shows no error.

## 13. Notifications

job-bot shows a notification when the AI rates a job `strong` (once per job, grouped above three) and after each daily run. On Linux it uses `notify-send`, from libnotify:

```bash
sudo apt-get install -y libnotify-bin
node --no-warnings -e "import('./src/notify.ts').then((m) => m.notify({ title: 'Job Bot', message: 'Test', url: 'http://localhost:3100' }))"
```

The second line shows a test notification through job-bot's own notifier.

Without `notify-send` (a server, a minimal system), the message only goes to `data/fetch.log` and the terminal (`notification (no notifier on this system)`). To turn job-bot's notifications off, add `JOB_BOT_NOTIFY=off` to `.env`; for strong matches only, set `config.json` → `ai.alertStrong` to `false`. `JOB_BOT_NOTIFY=<program>` runs your own program with the title, message and URL as arguments instead.

**Success:** the test notification appears on your desktop.

## 14. The Chrome extension

The extension sends the job you are looking at to job-bot, and shows the prepared CV, letter and answers in a side panel while you apply. **Fill this form** types them into the form's empty fields; it never overwrites a field, never clicks a button and never submits. It works in Google Chrome and Chromium.

1. Keep the dashboard running (`npm run web`).
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `extension` folder inside `~/job-bot`.
4. Pin the job-bot button to the toolbar (puzzle icon → pin).

It talks only to your local dashboard, `http://localhost:3100` by default; if you run the dashboard on another port, set its address in the extension's options (**Extension options** in the popup). Details and permissions: [extension/README.md](../../extension/README.md#dashboard-address-options).

**Success:** on any job page, the job-bot button opens a popup with the job's title and company read from the page.

## 15. Check that it works

`npm run bot -- doctor` checks most of this at once (Node, packages, settings, your CV and profile, the database, the PDF renderer and the AI) and prints how to fix each problem; it changes nothing.

- [ ] `node --version` is v24 or newer.
- [ ] `psql "postgres://jobbot:<password>@127.0.0.1:5432/job_bot" -c "SELECT 1;"` answers.
- [ ] `npm run bot -- settings:check --kind config --file config.json` prints `{"ok":true}`.
- [ ] `npm run bot -- cv:default` writes your CV, and the PDF looks right.
- [ ] `npm run bot -- stats` prints job counts.
- [ ] `npm run bot -- ai:score --limit 1` ends with `1 jobs scored.` (or `Nothing to score.` when every match is reviewed).
- [ ] <http://localhost:3100> shows jobs, and no profile banner.
- [ ] On a job page of the dashboard, **Prepare CV** and **Write letter** finish without an error.
- [ ] `systemctl --user list-timers job-bot-fetch.timer` shows the next run, and `data/fetch.log` has a run.
- [ ] `npm run bot -- backup` prints `backup: .../data/backups/job_bot-<date>.sql.gz`.
- [ ] A notification appeared after the test run.
- [ ] The extension's popup reads a job page.

Next: [daily-use.md](../daily-use.md) for the everyday workflow, [updating.md](../updating.md) when a new version comes out, and [troubleshooting.md](../troubleshooting.md) if something is off.

## Fedora and Arch

Only steps 1, 2 and 13 differ; everything from step 3 on is the same.

**Fedora:**

```bash
sudo dnf install -y libnotify
curl -fsSL https://rpm.nodesource.com/setup_24.x | sudo bash -
sudo dnf install -y nodejs
sudo dnf install -y postgresql-server
sudo postgresql-setup --initdb
sudo systemctl enable --now postgresql
```

Fedora's PostgreSQL uses `ident` for TCP connections, which refuses passwords. In `/var/lib/pgsql/data/pg_hba.conf`, change `ident` to `scram-sha-256` on the `host` lines for `127.0.0.1/32` and `::1/128`, then `sudo systemctl reload postgresql`. Create the user and database as in step 2.

**Arch:**

```bash
sudo pacman -S --needed nodejs npm postgresql libnotify
sudo -iu postgres initdb -D /var/lib/postgres/data
sudo systemctl enable --now postgresql
```

Then create the user and database as in step 2. Check `node --version` is 24 or newer.

The backup looks for `pg_dump` on the PATH, then in `/usr/lib/postgresql/<version>/bin` (Debian, Ubuntu) and `/usr/pgsql-<version>/bin` (RHEL-style packages). Elsewhere, set `JOB_BOT_PG_DUMP` in `.env` to its full path. `bot restore` looks for `psql` the same way (`JOB_BOT_PSQL`).
