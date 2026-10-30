# Roadmap: status

What was planned for job-bot and where each part lives now. None of it changes the core rule: the bot never applies on its own.

## Open

Nothing planned right now. Ideas from real use go here.

## Done

### Features

- **Funnel analytics:** `/analytics` (web/app/analytics, web/lib/analytics.ts).
- **Follow-up reminders:** "Needs follow-up" tab and a section on the job page; `bot follow-ups` / `follow-up` / `followed-up` (src/followup.ts, web/lib/followup.ts).
- **Interview prep:** `bot prep <id>`; on the job page for applied and interview jobs, run as a background task.
- **More sources:** Workday (`"ats": "workday"`, src/sources/index.ts), Arbeitnow and Adzuna (`remote.boards`, src/sources/boards.ts).
- **Instant alerts for strong matches:** src/notify.ts, called by `ai:score`; `ai.alertStrong` in config.json or on `/settings`.
- **Settings page:** `/settings` (web/app/settings, web/components/settings.tsx); `bot settings:check` / `settings:save`.
- **Learn from skips:** skip reasons (`mark <id> skipped --reason`, Skip button) and skip patterns on `/analytics` (web/lib/skip-insights.ts).
- **Dead-link check:** `bot check:open`; `prepare` checks first; status `expired` with its own tab (src/sources/open.ts).
- **ATS keyword check:** `bot ats <id>` and on the job page (src/ats.ts).
- **Salary extraction:** src/salary.ts; shown on cards, minimum-salary filter on the job list.
- **Contacts per job:** `bot contacts` / `contact:add`, and on the job page with referral reminders.
- **Chrome extension:** `extension/` (send a job, apply helper side panel, form auto-fill that never submits).

### Code and architecture

- **Background task queue:** `tasks` table, src/tasks.ts, web/lib/tasks.ts, `bot task:run <id>`.
- **Shared types:** src/types.ts, imported by the dashboard.
- **Settings validation:** zod schemas in src/settings.ts, checked at startup.
- **Split CLI:** one file per command in src/commands/; src/cli.ts is the registry.
- **Versioned migrations:** src/migrate.ts and src/migrations/NNN_name.sql.
- **HTTP retry and caching:** src/sources/http.ts (backoff with jitter, ETag / Last-Modified cache in data/http-cache).
- **Database backups:** `bot backup` (src/backup.ts: pg_dump + zlib, daily, keeps 14).
- **Cross-platform:** macOS, Linux and Windows. `bot daily` (src/commands/daily.ts) is the scheduled run on every OS (launchd through scripts/daily-fetch.sh, systemd or cron, Task Scheduler; `bot schedule:print`), notifications per OS (src/notify.ts), npm scripts without shell syntax (scripts/run-tests.mjs).

### Quality and tooling

- **CI:** .github/workflows/test.yml (Ubuntu with a Postgres service: lint, typecheck, backend and web suites; Windows: lint, typecheck and the tests that need no database).
- **Lint and format:** Biome (`biome.json`), `npm run lint` / `npm run format`, and a pre-commit hook in `.githooks/` that checks staged files.
- **Coverage report:** `npm run test:coverage` and `npm run test:web:coverage`.
- **Known test gaps closed:** job list and layout, `runBot`, CopyButton failure, the Bayt collector (web/tests).
- **Fetch errors on the dashboard:** fetch health on `/analytics` and a "Last fetch: N errors" link in the job list header.

## Privacy

- The repo is private because it contains your CV PDFs and `cv/master.json` (phone, email). If you ever want to make the code public, move personal CV data to a gitignored folder first and keep only an example CV in the repo.
