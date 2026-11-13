# Roadmap: status

What was planned for Talaash and where each part lives now. None of it changes the core rule: the bot never applies on its own.

## Open

Ideas from the last review and from real use, none started yet:

- **Company history and block list:** past applications and outcomes per company on the job page, and companies you never want to see again filtered out.
- **Interview rounds:** several rounds per job with date, type and notes, and an `.ics` file to add each one to a calendar.
- **Weekly goal and expiring badge:** a target of applications per week on the dashboard, and a badge on matching jobs about to pass `maxAgeDays`.
- **Postings that apply by email or WhatsApp:** detect them and prepare the message (with the CV attached by you) instead of a form.
- **Discover boards from seen companies:** suggest `discover` for companies that keep showing up on LinkedIn or the boards but have no ATS entry in `companies`.
- **Rejection stage and reason:** record where and why an application ended (screening, technical, final, ghosted), shown on `/analytics`.
- **Pre-submit checklist:** on the job page before **Mark applied**: CV version, letter, answers with `[FILL: ...]` left, contacts asked for a referral.
- **Referral drafts:** an AI-drafted message to a contact at the company asking for a referral (you send it yourself).

### From comparing similar projects (2026-11)

Ideas taken from the two most popular open-source job-search tools on GitHub, boss-agent-cli (one Chinese job site, Python) and Jobsmith (Taiwan's job market, desktop app). Their auto-apply, platform logins and bulk messaging are left out on purpose: they break the rule above and risk the user's accounts. Most useful first:

- **Skills radar:** the skills that matching jobs ask for most often, split into those the CV shows and those it does not, from the `missing` skills already stored per job. A section on `/analytics`.
- **Screenshots and a demo GIF:** the dashboard, a job page and the extension, in the README and the docs site.
- **Repository basics:** GitHub topics, a first release (`v0.1.0`) with a CHANGELOG, issue templates and `SECURITY.md`.
- **Letter critic:** after the AI writes a letter, a second call checks it for claims the CV does not support or company facts the posting does not state, and has it fixed (Jobsmith's own check moved its pass rate from 60% to 100%).
- **Mock interview:** questions from the job and the CV, the user's answers, and feedback with a score per answer, next to the interview prep.
- **JSON output:** `--json` on `list` and `show` (as `ats` has), so scripts and AI agents can use Talaash.
- **MCP server:** Talaash's jobs, scores, letters and answers as tools for MCP apps such as Claude Desktop (read and prepare only, never apply).
- **Running without PostgreSQL:** an embedded database (SQLite or similar) so a new user needs only Node.js. A large change across the bot and the dashboard.

## Done

### Features

- **CV templates and feedback on the CV:** classic, modern and compact designs (src/cv/templates), `cvTemplate` in config.json and per job (`bot cv:template`), `bot cv:feedback` with the master-CV check (src/cv/feedback.ts) and `bot cv:review`; the CV panel on the job page (web/components/cv-panel.tsx).
- **Funnel analytics:** `/analytics` (web/app/analytics, web/lib/analytics.ts).
- **Follow-up reminders:** "Needs follow-up" tab and a section on the job page; `bot follow-ups` / `follow-up` / `followed-up` (src/followup.ts, web/lib/followup.ts).
- **Interview prep:** `bot prep <id>`; on the job page for applied and interview jobs, run as a background task.
- **CV import (2026-11, from comparing similar projects):** `bot cv:import <file>` (PDF, .docx, .txt, .md) and **Import your CV** on the Settings page: the AI sorts the CV's text into `cv/master.json` fields, skills the text does not contain are dropped, and the draft only replaces the master CV after the user applies it, with a backup (src/cv/import.ts, src/commands/cv-import.ts, the `cv_import` task, migration 022).
- **Application deadline (2026-11):** the deadline a posting states is stored (`jobs.deadline`, migration 020), shown as **Closes in N days** on matching and prepared jobs, and a passed one filters the job (src/deadline.ts).
- **Job type filter (2026-11):** LinkedIn's employment type and seniority, and freehire's seniority, filter internships, part-time, temporary and volunteer jobs (`skipJobTypes`).
- **freehire.me source (2026-11, from comparing ai-job-search):** onsite postings per target country and remote ones open to your regions, from freehire's public search over about 50 ATS (`freehire` in `remote.boards`).
- **Posting safety and eligibility (2026-11, from comparing ai-job-search):** hidden HTML and invisible characters are dropped from postings, text aimed at AI tools is flagged and every AI prompt treats postings as data (src/posting-guard.ts); postings only for citizens, permanent residents or cleared staff are filtered; dedupe keeps non-Latin titles apart.
- **Dutch visa salary check (2026-11):** Dutch jobs that need a visa are flagged when their salary is below the IND highly-skilled-migrant minimum for your age (src/ind-salary.ts, `birthYear` in the profile).
- **More sources (2026-11):** Jobicy and Hacker News "Who is hiring" (`remote.boards`), and Personio career pages (`"ats": "personio"`).
- **Docker (2026-11):** `docker compose up -d` runs PostgreSQL, the dashboard and the daily run, with everything personal in `talaash-home/` (docs/install/docker.md).
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

- **Preset-driven scoring:** each stack preset carries its skill patterns and CV clusters (`skills` / `clusters` in presets/stacks/\*.json); scoring follows config.json `stacks` (missing or empty = `php-laravel` + `javascript`, the old built-in behaviour), with cross-stack skills in src/match.ts `BASE_SKILLS`.
- **Background task queue:** `tasks` table, src/tasks.ts, web/lib/tasks.ts, `bot task:run <id>`.
- **Shared types:** src/types.ts, imported by the dashboard.
- **One copy of the rules (2026-11):** config.json is read on first use (src/config.ts), and logic takes settings as a parameter (`scoreJob(job, cfg)`), so the dashboard imports the bot's profile, follow-up, contact, currency, CV template, AI preset and skip-reason rules from src/ instead of keeping copies with parity tests. The task queue's rules (src/task-queue.ts) take the database pool as a parameter, so the bot and the dashboard share them too.
- **Settings validation:** zod schemas in src/settings.ts, checked at startup.
- **Split CLI:** one file per command in src/commands/; src/cli.ts is the registry.
- **Versioned migrations:** src/migrate.ts and src/migrations/NNN_name.sql.
- **HTTP retry and caching:** src/sources/http.ts (backoff with jitter, ETag / Last-Modified cache in data/http-cache).
- **Database guards (migration 019):** `jobs.status` and `salary_period` take only the values the code knows, and `duplicate_of` must point at an existing job other than itself (deleting a primary makes its copies primaries again). The migration cleans any such value first.
- **Database backups:** `bot backup` (src/backup.ts: pg_dump + zlib, daily, keeps 14).
- **Hardening pass (2026-11):** sources survive bad dates and keep LinkedIn partial results, AI replies are validated and time-bounded, `ai:score` takes a lock and dedupe is atomic, settings fail loudly on a missing master CV or a config typo, and the dashboard polls more cheaply with one CV change per job.
- **Cross-platform:** macOS, Linux and Windows. `bot daily` (src/commands/daily.ts) is the scheduled run on every OS (launchd through scripts/daily-fetch.sh, systemd or cron, Task Scheduler; `bot schedule:print`), notifications per OS (src/notify.ts), npm scripts without shell syntax (scripts/run-tests.mjs).

### Quality and tooling

- **CI:** .github/workflows/test.yml (Ubuntu with a Postgres service: lint, typecheck, backend and web suites, a dashboard build and an informational coverage summary; Windows on Node 24 and 26: typecheck and the tests that need no database), on pull requests, pushes to main and a monthly schedule; Dependabot opens monthly npm update PRs (.github/dependabot.yml).
- **Lint and format:** Biome (`biome.json`), `npm run lint` / `npm run format`, and a pre-commit hook in `.githooks/` that checks staged files.
- **Coverage report:** `npm run test:coverage` and `npm run test:web:coverage`.
- **Known test gaps closed:** job list and layout, `runBot`, CopyButton failure, the Bayt collector (web/tests).
- **Fetch errors on the dashboard:** fetch health on `/analytics` and a "Last fetch: N errors" link in the job list header.

### Review waves (2026-11)

- **Wave 1:** `bot restore` (a fresh backup first, one transaction), extension lookup that tells apart jobs differing only in a job-id parameter, safer triage (bulk skip only on the Matching and Prepared tabs, keys act on the focused card), unknown stack ids rejected up front, CI builds the dashboard and restores a real backup.
- **Wave 2:** the AI budget cancels the request itself and a fatal AI error (or 3 timeouts in a row) stops `ai:score` at once; daily-run step timeouts, honest "all sources failed" exit, log rotation, IND auto-refresh and pruning of old filtered postings; bounded SmartRecruiters details and one HTML-to-text; no stale status rewinds, Undo of the last status change, confirmation before rewriting edited text.
- **Wave 3:** one `UserError` (no stack traces for problems the user can fix; "Not found" exits 1), scoring takes its stacks from `cfg`; the extension works on application pages, lists custom widgets as "pick from the list", has "Fill profile + CV only" and a dashboard-port option; dashboard UX (form success messages, split settings, back link and Previous / Next keeping the list, job-page keys, Reset filters, follow-ups on cards).
- **Wave 4:** a daily cleanup (old temp files, `data/cv-backups` down to 20, one-off CVs of jobs finished 90 days ago), `JOB_BOT_DATA_DIR` so tests never write to the real `data/`, `setup` offering to write a missing `.env` / `web/.env.local`, and dedupe writing only the rows that change.
- **Known limits closed:** Undo restores the real earlier applied date (`job_events.prev_applied_at`, migration 018), `/analytics` builds stages from real status changes only (a follow-up between "applied" and its undo no longer counts), Previous / Next on the job page keep working after the job leaves its list, and the IND-register test runs on a seeded register.

## Privacy

- The repo is public. Personal files are gitignored and stay on your computer: `cv/master.json`, the CV PDFs (`cv/default/`, `cv/original/`, `cv/versions/`), `cv/applicant.json`, `config.json`, `.env`, `applications/` and `data/`. Tests use `tests/fixtures/master-owner.json`, the owner's CV with placeholder contact details. Files removed from git still exist in its history.
