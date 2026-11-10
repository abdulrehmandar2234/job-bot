# Troubleshooting

Common problems and their fixes: first those on any system, then per OS.

Back to the [start page](README.md).

Contents:

- [Any system](#any-system)
  - [The dashboard does not load](#the-dashboard-does-not-load)
  - [A database error, or "column does not exist"](#a-database-error-or-column-does-not-exist)
  - [The 9:00 run did not happen](#the-900-run-did-not-happen)
  - [No jobs match](#no-jobs-match)
  - [LinkedIn returns 429](#linkedin-returns-429)
  - ["AI review failed (is Claude signed in?)"](#ai-review-failed-is-claude-signed-in)
  - [An API key is rejected](#an-api-key-is-rejected)
  - ["AI review failed ...; stopped early"](#ai-review-failed--stopped-early)
  - ["Missing or wrong import token" (Bayt bookmarklet)](#missing-or-wrong-import-token-bayt-bookmarklet)
  - [No Chrome found, or Chrome fails to launch](#no-chrome-found-or-chrome-fails-to-launch)
  - [The CV PDF has someone else's headline or summary](#the-cv-pdf-has-someone-elses-headline-or-summary)
  - [No notifications](#no-notifications)
  - [The backup fails](#the-backup-fails)
  - [Restore a backup](#restore-a-backup)
  - [The "Set up your profile" banner](#the-set-up-your-profile-banner)
  - ["Invalid settings file ..."](#invalid-settings-file-)
  - [Tests fail after you replaced `config.json` or `cv/master.json`](#tests-fail-after-you-replaced-configjson-or-cvmasterjson)
- [macOS](#macos)
- [Linux](#linux)
- [Windows](#windows)

## Any system

### The dashboard does not load

It only runs while `npm run web` is running, and nothing starts it after a reboot: start it again. It binds to `127.0.0.1`, so use <http://localhost:3100> or <http://127.0.0.1:3100> on the same computer; it is not reachable from your phone or another computer, and any other Host header gets "job-bot only answers on localhost". If port 3100 is taken, `npm run web` says so: stop the other program (or an older `npm run web` in another window). To use another port instead, run `npm --prefix web run dev -- -p 3200` and set `http://localhost:3200` in the Chrome extension's options.

### A database error, or "column does not exist"

- **`DATABASE_URL missing — add it to .env`:** the bot needs `DATABASE_URL` in `.env`, and the dashboard in `web/.env.local` (see your install guide, step 4). `npm run bot -- setup` offers to write whichever is missing (`DATABASE_URL` only; it never overwrites a file).
- **`ECONNREFUSED 127.0.0.1:5432`:** PostgreSQL is not running. macOS: start the server in DBngin, or `brew services start postgresql@17`. Linux: `sudo systemctl start postgresql`. Windows: start the `postgresql-x64-17` service (`Start-Service postgresql-x64-17` in an administrator PowerShell, or the Services app).
- **`password authentication failed for user ...`:** the password in `DATABASE_URL` is wrong, or has characters that must be percent-encoded (`@` → `%40`, `/` → `%2F`, `:` → `%3A`, `#` → `%23`).
- **`SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string`:** the server wants a password and `DATABASE_URL` has none: use `postgres://<user>:<password>@127.0.0.1:5432/job_bot`.
- **`database "job_bot" does not exist`:** create it (install guide, step 2).
- **"column ... does not exist" on the dashboard after an update:** the dashboard does not apply database migrations itself; the bot does, on its next database command. Run `npm run bot -- stats`, then reload the page.

### The 9:00 run did not happen

Run it by hand any time with `npm run bot -- daily`, or **Fetch new jobs** on the dashboard. Then check `data/fetch.log`:

- `Fetch failed — is PostgreSQL running?`: the database was down at 9:00.
- `Fetch failed: N of N sources failed — is the network up?`: no source answered (offline, or a VPN/proxy blocking them); the first error follows. `N of M sources failed.` after a normal summary means only some did; their errors are in the log.
- `<step> timed out after N min`: a step hung and was stopped (limits: fetch 30 min, check:open 15, ai:score 60, backup 10, the IND register refresh 10); the steps after it still ran, and the notification says `Timed out: ...`.
- `sponsors:update failed`: the weekly IND register refresh did not work; the old register stays and the run goes on.
- `AI review failed (is Claude signed in? See data/fetch.log)` in the notification: `ai:score` failed or stopped early; the line above it in the log says why ([below](#ai-review-failed--stopped-early)). The fetch result is still reported.
- `A fetch is already running; skipping.`: a fetch from the dashboard was running at the same time.
- Nothing new in the log at all: the scheduler did not start it; see your OS below.

Missed runs: launchd (macOS) catches up after sleep but not after a shut-down; a systemd timer with `Persistent=true` (Linux) runs at the next boot; Task Scheduler with `-StartWhenAvailable` (Windows) runs as soon as the computer is on; cron and `schtasks` skip it.

### No jobs match

Look at the reasons first: the **Filtered out** tab, or `npm run bot -- list --status filtered`.

- "location not in target countries": widen `countries.<code>.match` (cities, spellings), or the jobs are elsewhere.
- "title is not an engineering role" / "title excluded": your titles are not in `roleInclude`, or `roleExclude` catches them (the repository's list excludes Python, Java, Go, mobile, DevOps, QA, management and more).
- "remote, region does not include ...": check `remote.fromCode` (Settings → Remote boards). If your country is right and the region should include you, add it to `remote.allow` or open an issue so it goes into `src/regions.ts` ([Remote regions](configuration.md#remote-regions)).
- "score N below minScore": lower `minScore`, or add the skills you have to `cv/master.json`.
- "NL job but company not on IND sponsor register": the daily run downloads the register again once it is a week old (only when a country uses `ind-register`); `npm run bot -- sponsors:update` does it now.
- "no recognisable tech stack": your stack is not in the keyword list in `src/match.ts`; rely on the AI score and keep `minScore` low.
- `location (AI): ...`: the AI review read the description and found you cannot take the job from where you live. `npm run bot -- ai:score --location-filtered` re-checks those jobs (after you changed your profile or `remote.*`) and brings back the ones that pass.

Then `npm run bot -- rescore` (no downloads). Also check that `companies`, `linkedin.keywords` and `remote.himalayasQueries` are about your stack and markets, not the original owner's ([configuration.md](configuration.md)).

### LinkedIn returns 429

LinkedIn throttles guest searches from your IP. The bot stops LinkedIn for that run and keeps what it had; the other sources are unaffected. It usually clears within a day. Make fewer requests: fewer `linkedin.keywords` or `locations`, `pagesPerSearch: 1`, or `linkedin.enabled: false` for a few days.

### "AI review failed (is Claude signed in?)"

The Claude Code CLI is signed out, or not at `ai.claudePath`. Run `claude` in a terminal and sign in (`/login`). Compare `which claude` (Windows: `where.exe claude`) with `config.json` → `ai.claudePath`: a fresh clone still has the original owner's path, so run `npm run bot -- setup` or fix it. Then `npm run bot -- ai:score`. Fetching is not affected: the daily run only skips the review and says so in the notification.

If you have no AI at all, see [ai.md](ai.md#running-without-ai): the fit review is not covered by `ai.enabled: false` and keeps failing, which is harmless.

### An API key is rejected

A 401/403 stops at once with a message naming `AI_API_KEY` and the provider. Check the key in `.env` (no quotes or spaces around it), and that the detected provider is right: a DeepSeek, Mistral or Together key needs `"ai": { "api": { "preset": "..." } }`, because DeepSeek keys look like OpenAI keys and the others have no known prefix. The Settings page shows which provider the key looks like.

### "AI review failed ...; stopped early"

`ai:score` stops at once, with this one line and exit 1, when the problem would hit every job in the queue: a rejected or missing key, no credit, no model or base URL set, the Claude CLI not installed or signed out, or 3 reviews in a row that timed out (the provider is not answering). The jobs it did not try stay `new` and are reviewed on the next run. Fix what the line names ([An API key is rejected](#an-api-key-is-rejected), [Claude signed in](#ai-review-failed-is-claude-signed-in)), then run `npm run bot -- ai:score`. Every single AI call has a 5-minute budget; a dashboard task that runs longer is stopped and shows `Timed out after N minutes (last error: ...)`.

### "Missing or wrong import token" (Bayt bookmarklet)

The Bayt collector got a 403 from `/api/import`. Jobs sent from job sites must carry the per-installation import token (`data/import-token`, created on first use), which the dashboard puts into the collector each time the bookmarklet loads it. It is missing or wrong when the collector did not come through the dashboard's bookmarklet (`scripts/bayt-collect.js` pasted into the console, or a bookmark copied from another install), or when `data/import-token` was deleted or replaced after the Bayt page loaded the collector. Start the dashboard, delete the old bookmark, drag the bookmarklet from the dashboard's **Add jobs from Bayt** section to the bookmarks bar again, reload the Bayt page and click it. The Chrome extension needs no token.

### No Chrome found, or Chrome fails to launch

Seen on `cv:default`, **Prepare CV** or **Download PDF**. Install the headless shell once:

```bash
npx playwright-core install chromium-headless-shell
```

It goes to `~/Library/Caches/ms-playwright` on macOS, `~/.cache/ms-playwright` on Linux and `%LOCALAPPDATA%\ms-playwright` on Windows. After an update that changed `playwright-core`, run it again: the bot needs a matching shell. Or keep `chromePath: "auto"` with Google Chrome installed, or set `chromePath` (or `JOB_BOT_CHROME`) to a Chrome executable: on macOS the binary inside the app bundle, not the `.app` folder (`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`); on Windows `C:\Program Files\Google\Chrome\Application\chrome.exe`; on Linux `/usr/bin/google-chrome`. On a minimal Linux, see [Linux](#linux).

### The CV PDF has someone else's headline or summary

You built a per-stack CV version (`prepare --cv <cluster>`, `cv:build`, `custom`, or `autoCvVersions: true`). Those framings in `src/cv/profiles.ts` are written for the original owner's CV. Set `"autoCvVersions": false`, prepare the job again (the default CV is your own master CV), and see [your-cv-and-profile.md](your-cv-and-profile.md#cv-versions-and-the-per-stack-framings).

### No notifications

Run `npm run bot -- daily` by hand: `data/fetch.log` gets a `notification:` line with the text, and the terminal shows `notification failed: ...` or `notification (no notifier on this system)` when it could not be shown. `JOB_BOT_NOTIFY=off` in `.env` turns them off on purpose, and `ai.alertStrong: false` turns off the strong-match alerts. Per OS: [macOS](#macos), [Linux](#linux), [Windows](#windows).

### The backup fails

`npm run bot -- backup` shows why.

- `pg_dump not found`: put PostgreSQL's `bin` folder on the PATH, or set `JOB_BOT_PG_DUMP` in `.env` to `pg_dump`'s full path (`pg_dump.exe` on Windows).
- A password error: put the password in `DATABASE_URL` in `.env`.
- `server version mismatch`: use the `pg_dump` of the same (or a newer) PostgreSQL version as the server, through `JOB_BOT_PG_DUMP`.

### Restore a backup

Database migrations only go forward, so a backup is the way back from a bad update or a damaged database. The daily run keeps one per day for 14 days in `data/backups/` (`job_bot-YYYY-MM-DD.sql.gz`); `npm run bot -- backup` makes one now.

1. Stop the dashboard (Ctrl+C where `npm run web` runs), so nothing holds the database open.
2. Pick the file, e.g. the last one from before the problem: `ls data/backups` (Windows: `dir data\backups`).
3. Restore it:

   ```bash
   npm run bot -- restore data/backups/job_bot-2026-01-31.sql.gz
   ```

   The database already has tables, so this only prints what would be replaced (the database name, the backup's date and size) and stops. Run it again with `--yes`:

   ```bash
   npm run bot -- restore data/backups/job_bot-2026-01-31.sql.gz --yes
   ```

   It first backs up the current database to `data/backups/job_bot-before-restore-<date>-<time>.sql.gz` (restore that file to undo the restore; these copies are not deleted with the daily ones), then replaces the database's `public` schema with the backup in one transaction: if anything fails, nothing is changed. It ends with the number of tables and jobs restored.

4. Start the dashboard again. Migrations newer than the backup apply on the next bot command, or when the dashboard starts.

To look at a backup without touching your data, restore it into another database on the same server: `createdb job_bot_old`, then `npm run bot -- restore <file> --into job_bot_old`. A database that does not exist yet must be created first (`createdb <name>`); after a reinstall of PostgreSQL, create `job_bot` again (install guide, step 2) and restore into it.

**A backup holds the database only:** the jobs with their statuses, notes and AI reviews, contacts and tasks. It does not hold `config.json`, `.env`, `cv/applicant.json`, your edits to `cv/master.json`, the generated CVs in `cv/versions/`, the letters and PDFs in `applications/`, or `data/import-token`. Copy those files yourself if you want them kept too.

Problems:

- `psql not found`: put PostgreSQL's `bin` folder on the PATH, or set `JOB_BOT_PSQL` in `.env` to `psql`'s full path (`psql.exe` on Windows). It is looked for in the same folders as `pg_dump`.
- `is not a complete pg_dump file` or `is a damaged gzip file`: the file was cut short (a full disk, an interrupted copy). Take the backup of the day before.
- `restore failed: psql exited 3`: the line after it is PostgreSQL's error. Nothing was changed. A dump made by a newer PostgreSQL than the server may use features the server lacks.
- `pg_dump not found, so the current job_bot cannot be backed up first`: restore will not replace a database it cannot back up; fix `pg_dump` as in [The backup fails](#the-backup-fails).

### The "Set up your profile" banner

"Welcome! Set up your profile first." or "Your profile is incomplete." means `cv/applicant.json` is missing, or the profile lacks a name, email, location, country code or languages. Run `npm run bot -- setup` or open **Settings** on the dashboard. Name, email and location may also come from `cv/master.json`.

### "Invalid settings file ..."

The message names each bad field with its path, e.g. `companies[3].ats`. Fix it, then `npm run bot -- settings:check --kind config --file config.json` (or `--kind applicant --file cv/applicant.json`).

### Tests fail after you replaced `config.json` or `cv/master.json`

Some tests pin the original owner's letters and filter results (`tests/fixtures/owner-golden.json`) against `config.default.json` and the repository's `cv/master.json`. That is expected with your own files; the tests are for developing the bot. They also need their own databases (`npm run test:db -- job_bot_test_bot job_bot_test`), which connect as `postgres` without a password: see `CLAUDE.md`.

## macOS

- **The daily run never starts, and `data/fetch.log` stays empty.** The project is under `~/Desktop`, `~/Documents` or `~/Downloads`, which macOS does not let a launchd job read: move it (and update the plist), or check `data/launchd.err.log`.
- **`node not found on PATH` in `data/fetch.log`.** `scripts/daily-fetch.sh` only looks in `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin` and `/bin`. Install Node with `brew install node`, or link an nvm/fnm Node: `sudo ln -sf "$(which node)" /usr/local/bin/node`.
- **Run it now, or check it is loaded:** `launchctl kickstart gui/$(id -u)/com.<you>.job-bot.fetch`; `launchctl print gui/$(id -u)/com.<you>.job-bot.fetch`.
- **Also run at login** (to catch up after a shut-down): add `<key>RunAtLoad</key><true/>` to the plist, then `launchctl bootout gui/$(id -u)/com.<you>.job-bot.fetch` and `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.<you>.job-bot.fetch.plist`.
- **No notifications:** System Settings → Notifications must allow **Script Editor** (used by `osascript`) or **terminal-notifier**, and Focus / Do Not Disturb must be off. A notification that times out (`timed out after 15 s`) usually means the Mac was locked.
- **`createdb: command not found`:** DBngin's and Homebrew's `postgresql@N` tools are not on the PATH; see [macOS step 2](install/macos.md#2-install-postgresql-and-create-the-database).
- **`role "postgres" does not exist`** with Homebrew's PostgreSQL: run `createuser -s postgres` once.

## Linux

- **`password authentication failed` or `Ident authentication failed`:** the connection over `127.0.0.1` needs the user's password in `DATABASE_URL`. On Fedora, change `ident` to `scram-sha-256` in `pg_hba.conf` ([Linux guide](install/linux.md#fedora-and-arch)). To reset the password: `sudo -u postgres psql -c "ALTER USER jobbot PASSWORD 'new-password'"`.
- **The timer does not run:** `systemctl --user status job-bot-fetch.service` and `journalctl --user -u job-bot-fetch` show the last run and its errors; `systemctl --user list-timers` the next one. A timer that never fires while you are logged out needs `sudo loginctl enable-linger $USER`.
- **`status=203/EXEC` in the service status:** the Node path in `ExecStart` is wrong (often an nvm Node that changed version). Run `npm run bot -- schedule:print` again and update the unit, then `systemctl --user daemon-reload`.
- **Cron runs but nothing shows:** cron needs Node's full path in the crontab line, and `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<id -u>/bus` above it for notifications.
- **No notifications:** install `notify-send` (`libnotify-bin` on Debian/Ubuntu, `libnotify` on Fedora and Arch). On a server without a desktop there is nothing to show; set `JOB_BOT_NOTIFY=off`.
- **Chrome fails to launch with a missing `.so` library:** install the shell's system libraries with `npx playwright-core install-deps chromium-headless-shell` (Debian and Ubuntu), or install your distribution's Chromium and keep `chromePath: "auto"`.
- **`psql --version` is older than 15:** install a current PostgreSQL from the PostgreSQL project's repository ([Linux step 2](install/linux.md#2-install-postgresql-and-create-the-database)).

## Windows

- **`npm` fails with "running scripts is disabled on this system":** PowerShell's execution policy blocks npm's PowerShell wrapper. Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or type `npm.cmd` instead of `npm`.
- **A flag is ignored, or npm warns `Unknown cli config "--company"`:** some npm versions' PowerShell wrapper drops the `--` in `npm run bot -- <command> --flag`, so npm takes the flag for itself. Use `npm.cmd run bot -- <command> --flag`, or run the command in Command Prompt.
- **`createdb` / `psql` is not recognized:** the PostgreSQL tools are not on the PATH. For the current window: `$env:Path += ';C:\Program Files\PostgreSQL\17\bin'`. The backup finds `pg_dump.exe` there by itself.
- **The Claude CLI path:** `where claude` in PowerShell is a different command (an alias of `Where-Object`) and prints nothing; use `where.exe claude`. `ai.claudePath` must be the native installer's `claude.exe` (`C:\Users\<you>\.local\bin\claude.exe`), not an npm `claude.cmd`, which the bot cannot start. In `config.json`, write the path with double backslashes or forward slashes.
- **The task does not run:** Task Scheduler (`taskschd.msc`) shows the task's **Last Run Result**; `Get-ScheduledTaskInfo -TaskName 'job-bot daily fetch'` shows it in PowerShell. The task runs only while you are logged in. With `schtasks`, a path with spaces in `/TR` needs the `\"` quoting that `schedule:print` prints. After moving Node or the project, run `schedule:print` again and register the task again (`-Force` replaces it).
- **No toast:** Settings → System → Notifications must be on and allow **Windows PowerShell**; Focus assist / Do not disturb hides toasts. If toasts are unavailable, the bot shows a tray balloon instead.
- **The PostgreSQL service is stopped:** `Get-Service postgresql*` shows it; start it in the Services app or with `Start-Service postgresql-x64-17` in an administrator PowerShell.
- **`npm test` runs only part of the tests:** the npm scripts run in PowerShell and cmd.exe, but many tests start small POSIX shell scripts as fake programs, so on Windows only part of them run (CI runs that part on `windows-latest`). This only matters for developing the bot.
- **Line endings:** the repository keeps LF line endings on every OS (`.gitattributes`), so Biome and the pre-commit hook (a `sh` script that Git for Windows runs) work whatever `core.autocrlf` says.
