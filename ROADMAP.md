# Roadmap: status

What was planned for job-bot and where each part lives now. None of it changes the core rule: the bot never applies on its own.

## Open

Nothing planned right now. Ideas from real use go here.

## Done

### Features

- **CV templates and feedback on the CV:** classic, modern and compact designs (src/cv/templates), `cvTemplate` in config.json and per job (`bot cv:template`), `bot cv:feedback` with the master-CV check (src/cv/feedback.ts) and `bot cv:review`; the CV panel on the job page (web/components/cv-panel.tsx).
- **Funnel analytics:** `/analytics` (web/app/analytics, web/lib/analytics.ts).
- **Follow-up reminders:** "Needs follow-up" tab and a section on the job page; `bot follow-ups` / `follow-up` / `followed-up` (src/followup.ts, web/lib/followup.ts).
- **Interview prep:** `bot prep <id>`; on the job page for applied and interview jobs, run as a background task.
- **More sources:** Workday (`"ats": "workday"`, src/sources/index.ts), Arbeitnow and Adzuna (`remote.boards`, src/sources/boards.ts).
- **Instant alerts for strong matches:** src/notify.ts, called by `ai:score`; `ai.alertStrong` in config.json or on `/settings`.
- **Settings page:** `/settings` (web/app/settings, web/components/settings.tsx); `bot settings:check` / `settings:save`.
- **Keyboard triage and bulk skip:** j/k, Enter, o, a, p, s on the job list, x / shift-click with "Skip selected" (web/components/triage.tsx, `skipSelected` in web/app/actions.ts).
- **Learn from skips:** skip reasons (`mark <id> skipped --reason`, Skip button) and skip patterns on `/analytics` (web/lib/skip-insights.ts).
- **Dead-link check:** `bot check:open`; `prepare` checks first; status `expired` with its own tab (src/sources/open.ts).
- **ATS keyword check:** `bot ats <id>` and on the job page (src/ats.ts); its folded heading counts the job skills the CV is missing.
- **Confirm missing skills:** "I have this" on the job page and `cv:feedback <id> --add-skills` add confirmed job skills to the master CV, with a backup first (src/cv/confirm-skills.ts).
- **Day / night theme:** a toggle in the dashboard header (web/components/theme-toggle.tsx) that follows the system until a choice is saved.
- **Salary extraction:** src/salary.ts; shown on cards, minimum-salary filter on the job list.
- **Contacts per job:** `bot contacts` / `contact:add`, and on the job page with referral reminders.
- **Chrome extension:** `extension/` (send a job, apply helper side panel, form auto-fill that never submits).

### Code and architecture

- **Background task queue:** `tasks` table, src/tasks.ts, web/lib/tasks.ts, `bot task:run <id>`.
- **Shared types:** src/types.ts, imported by the dashboard.
- **One copy of the rules (2026-11):** config.json is read on first use (src/config.ts), and logic takes settings as a parameter (`scoreJob(job, cfg)`), so the dashboard imports the bot's profile, follow-up, contact, currency, CV template, AI preset and skip-reason rules from src/ instead of keeping copies with parity tests. The task queue's rules (src/task-queue.ts) take the database pool as a parameter, so the bot and the dashboard share them too.
- **Settings validation:** zod schemas in src/settings.ts, checked at startup.
- **Split CLI:** one file per command in src/commands/; src/cli.ts is the registry.
- **Versioned migrations:** src/migrate.ts and src/migrations/NNN_name.sql.
- **HTTP retry and caching:** src/sources/http.ts (backoff with jitter, ETag / Last-Modified cache in data/http-cache).
- **Database backups:** `bot backup` (src/backup.ts: pg_dump + zlib, daily, keeps 14).
- **Hardening pass (2026-11):** sources survive bad dates and keep LinkedIn partial results, AI replies are validated and time-bounded, `ai:score` takes a lock and dedupe is atomic, settings fail loudly on a missing master CV or a config typo, and the dashboard polls more cheaply with one CV change per job.
- **Cross-platform:** macOS, Linux and Windows. `bot daily` (src/commands/daily.ts) is the scheduled run on every OS (launchd through scripts/daily-fetch.sh, systemd or cron, Task Scheduler; `bot schedule:print`), notifications per OS (src/notify.ts), npm scripts without shell syntax (scripts/run-tests.mjs).

### Quality and tooling

- **CI:** .github/workflows/test.yml (Ubuntu with a Postgres service: lint, typecheck, backend and web suites; Windows: typecheck and the tests that need no database), on pull requests, pushes to main and a monthly schedule; Dependabot opens monthly npm update PRs (.github/dependabot.yml).
- **Lint and format:** Biome (`biome.json`), `npm run lint` / `npm run format`, and a pre-commit hook in `.githooks/` that checks staged files.
- **Coverage report:** `npm run test:coverage` and `npm run test:web:coverage`.
- **Known test gaps closed:** job list and layout, `runBot`, CopyButton failure, the Bayt collector (web/tests).
- **Fetch errors on the dashboard:** fetch health on `/analytics` and a "Last fetch: N errors" link in the job list header.

## Privacy

- The repo is private because it contains your CV PDFs and `cv/master.json` (phone, email). If you ever want to make the code public, move personal CV data to a gitignored folder first and keep only an example CV in the repo.
