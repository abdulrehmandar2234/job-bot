# Roadmap: status

What was planned for job-bot and where each part lives now. None of it changes the core rule: the bot never applies on its own.

## Open

- **Follow-up reminders** (postponed). Flag jobs that have been `applied` for 7–10 days with no update, and draft a short follow-up message for the recruiter (you send it yourself). Show a "Needs follow-up" tab on the dashboard.
- **Lint and format** (not started). Biome or ESLint + Prettier, and a pre-commit hook that runs them.

## Done

### Features

- **Funnel analytics:** `/analytics` (web/app/analytics, web/lib/analytics.ts).
- **Interview prep:** `bot prep <id>`; on the job page for applied and interview jobs, run as a background task.
- **More sources:** Workday (`"ats": "workday"`, src/sources/index.ts), Arbeitnow and Adzuna (`remote.boards`, src/sources/boards.ts).
- **Instant alerts for strong matches:** src/notify.ts, called by `ai:score`; `ai.alertStrong` in config.json or on `/settings`.
- **Settings page:** `/settings` (web/app/settings, web/components/settings.tsx); `bot settings:check` / `settings:save`.
- **Learn from skips:** skip reasons (`mark <id> skipped --reason`, Skip button) and skip patterns on `/analytics` (web/lib/skip-insights.ts).
- **Dead-link check:** `bot check:open`; `prepare` checks first; status `expired` with its own tab (src/sources/open.ts).
- **ATS keyword check:** `bot ats <id>` and on the job page (src/ats.ts).
- **Salary extraction:** src/salary.ts; shown on cards, minimum-salary filter on the job list.
- **Contacts per job:** `bot contacts` / `contact:add`, and on the job page with referral reminders.
- **Chrome extension:** `extension/` (send a job, apply helper side panel; never fills in forms).

### Code and architecture

- **Background task queue:** `tasks` table, src/tasks.ts, web/lib/tasks.ts, `bot task:run <id>`.
- **Shared types:** src/types.ts, imported by the dashboard.
- **Settings validation:** zod schemas in src/settings.ts, checked at startup.
- **Split CLI:** one file per command in src/commands/; src/cli.ts is the registry.
- **Versioned migrations:** src/migrate.ts and src/migrations/NNN_name.sql.
- **HTTP retry and caching:** src/sources/http.ts (backoff with jitter, ETag / Last-Modified cache in data/http-cache).
- **Database backups:** scripts/backup-db.sh (daily, keeps 14).

### Quality and tooling

- **CI:** .github/workflows/test.yml (Postgres service, backend and web suites).
- **Coverage report:** `npm run test:coverage` and `npm run test:web:coverage`.
- **Known test gaps closed:** job list and layout, `runBot`, CopyButton failure, the Bayt collector (web/tests).
- **Fetch errors on the dashboard:** fetch health on `/analytics` and a "Last fetch: N errors" link in the job list header.

## Privacy

- The repo is private because it contains your CV PDFs and `cv/master.json` (phone, email). If you ever want to make the code public, move personal CV data to a gitignored folder first and keep only an example CV in the repo.
