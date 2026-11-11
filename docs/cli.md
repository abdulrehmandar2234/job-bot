# CLI reference

Every command of the bot. Run them from the Talaash folder as `npm run bot -- <command>`; `npm run bot` alone prints this list, and a command run without a required job id prints its usage line. The ones you need every day are explained in [Daily use](daily-use.md#cli-commands-for-every-day).

## Commands

```bash
npm run bot -- setup                          # first run: your profile and target markets (asks, validates, saves)
npm run bot -- doctor                         # check the setup: Node, packages, settings, CV, database, PDF renderer, AI
npm run bot -- fetch [--company <name>]       # fetch all sources (or those whose name contains <name>, e.g. linkedin)
npm run bot -- rescore                        # re-apply filters after editing config.json, no downloads
npm run bot -- list [--status new] [--country NL] [--min 60] [--limit 30]   # --status filtered shows the reasons
npm run bot -- show <id> [--full]
npm run bot -- ai:score [--id <id>] [--limit N] [--all]   # AI fit review of new matches (--all: review them again)
npm run bot -- prepare <id> [--cv laravel] [--force] [--letter]   # CV only; --letter also writes the letter
npm run bot -- letter <id> [--template]       # write or rewrite the cover letter
npm run bot -- letter <id> --feedback "shorter"   # AI rewrites the current letter with your feedback (prints a note on what it left out)
npm run bot -- summary <id> [--feedback "…"]  # AI CV summary for this job (or rewrite it with feedback)
npm run bot -- cv:tailor <id>                 # one-off CV with the job's CV summary, set as the job's CV
npm run bot -- cv:templates                   # list the CV templates (classic, modern, compact)
npm run bot -- cv:template <id> <template>    # use a template for this job; re-renders its CV as a new version
npm run bot -- cv:preview <template> [--pdf]  # your master CV in a template (HTML, or data/previews/<template>.pdf)
npm run bot -- cv:feedback <id> --feedback "put Laravel experience first"  # AI revises the job's CV (master CV content only)
npm run bot -- cv:feedback <id> --add-skills "Docker,GraphQL"         # add job skills you really have to the master CV, then revise
npm run bot -- cv:review <id>                 # AI suggests how to improve the job's CV for this job
npm run bot -- letter:pdf <id>                # cover letter as a PDF in the job's applications/ folder
npm run bot -- check:open [<id>...] [--status new,prepared] [--limit N]  # mark closed postings expired
npm run bot -- answer <id> [--file q.txt] [--clear]
npm run bot -- prep <id>                      # AI interview prep (questions, STAR stories, brief, gaps)
npm run bot -- follow-ups                      # applied jobs with no news for 7+ days
npm run bot -- follow-up <id> [--template]     # draft a follow-up message (you send it yourself)
npm run bot -- followed-up <id>                # record a sent follow-up (reminds again after 7 days, at most 2)
npm run bot -- custom <id> --overrides o.json # one-off CV for a single job (new custom-…-v<N> folder each run)
npm run bot -- mark <id> applied|interview|offer|rejected|skipped|expired ["note"] [--reason stack|seniority|salary|location|company|language|other]
npm run bot -- contacts <id>                  # a job's contacts, plus people you know at the same company
npm run bot -- contact:add <id> --name "Jane" [--role recruiter|"hiring manager"|referral|other] [--email x] [--phone x]
                [--linkedin https://...] [--notes x] [--referral "to ask"]
npm run bot -- add [--file job.json]          # add a job manually (JSON or stdin)
npm run bot -- discover <company...> [--add]   # find a company's board (6 ATS by name, or a myworkdayjobs URL); --add validates config.json and writes it atomically
npm run bot -- migrate                        # apply pending database migrations (the dashboard also does this on start)
npm run bot -- cv:default | cv:build [cluster...] | versions
npm run bot -- ats <id> [--cv next-nest] [--json] # CV keyword check: shown, hidden but true, missing
npm run bot -- sponsors:update | stats | dedupe
npm run bot -- settings:check|settings:save --kind config|applicant [--file x.json]  # validate (and save) settings, JSON result; no --file reads stdin
npm run bot -- task:run <id>                  # run a queued background task (the dashboard starts these)
npm run bot -- daily                         # the scheduled morning run: fetch, check:open, ai:score, notification, backup, cleanup
npm run bot -- schedule:print [--os macos|linux|windows]   # the scheduler setup for this clone and OS
npm run bot -- backup                        # pg_dump into data/backups/<db>-YYYY-MM-DD.sql.gz (keeps 14)
npm run bot -- restore <file> [--into db] [--yes]  # load a backup with psql; a database with tables needs --yes (backed up first)
```

`add` JSON format:

```json
{
  "source": "bayt",
  "company": "X",
  "title": "Senior Laravel Developer",
  "location": "Dubai, UAE",
  "url": "https://...",
  "description": "full job text"
}
```

## Daily fetch

`npm run bot -- daily` runs `fetch`, `check:open --limit 100` and `ai:score`, shows a notification with the result, backs up the database and cleans up leftover files (temporary files, old `data/cv-backups`, one-off CVs of long-finished jobs), logging to `data/fetch.log`. It runs once a day at `dailyTime` in `config.json` (default 09:00; **Daily run time** on the Settings page). `daily --if-due` starts the run only when it is due, so on macOS and Linux the scheduler checks every 30 minutes and a new time needs no other change; `npm run bot -- schedule:print` prints the setup for your OS with your paths filled in (step 12 of each [install guide](README.md#1-install-it-on-your-computer) has the details):

| OS      | Scheduler                                                                | A missed run (computer asleep or off) | After changing `dailyTime` |
| ------- | ------------------------------------------------------------------------ | ------------------------------------- | -------------------------- |
| macOS   | launchd: `scripts/daily-fetch.sh --if-due` every 30 minutes and at login | at the first check after it           | nothing to do              |
| Linux   | systemd user timer (or a cron line): `daily --if-due` every 30 minutes   | at the first check after it           | nothing to do              |
| Windows | Task Scheduler (`Register-ScheduledTask` or `schtasks`) at `dailyTime`   | when the computer is on again         | run `schedule:print` again |

Each step has a time limit (fetch 30 min, check:open 15, ai:score 60, backup 10): a step that hangs is stopped, named in the notification, and the rest still run. `fetch` exits 1 when every source failed ("All N sources failed — is the network up?") and reports "N of M sources failed" otherwise. `data/fetch.log` and the task log rotate at 5 MB. What each message means: [troubleshooting](troubleshooting.md#the-daily-run-did-not-happen).

On macOS, keep the project out of `~/Desktop` and `~/Documents`, because macOS does not let background jobs read them. Run a full run now, whatever the time, with `npm run bot -- daily`; on Windows also `Start-ScheduledTask -TaskName 'job-bot daily fetch'`.
