# job-bot

Local job-search helper: Node CLI bot (`src/`, TypeScript run directly by Node 24+) and a Next.js dashboard (`web/`), both on the local Postgres DB `job_bot`. See README.md for features, architecture and usage, and ROADMAP.md for what is done and what is still open.

## Rules

- The bot never applies to a job. It finds, scores and prepares (CV, cover letter, form answers). The user applies themselves.
- Nothing personal is hardcoded. Name, contact, location, languages and letter sentences come from the profile (`cv/applicant.json`, `src/profile.ts`, falling back to `cv/master.json`); target countries, visa needs and the remote-from country from `config.json`. Prompts say "the candidate", never he/his. The dashboard uses the same profile rules (`web/lib/market.ts` imports `src/profile.ts`).
- `config.json` is personal and gitignored: it starts as a copy of `config.default.json` (`ensureConfigFile` in `src/settings.ts`, `web/lib/settings.ts`; tests use a temp copy via `tests/helpers.ts`, `web/tests/setup.ts`). `config.default.json` holds the owner's search settings, nothing personal; `presets/` (markets, stacks; `src/presets.ts`) are offered by the setup wizard and `tests/presets.test.ts` keeps the default equal to gulf+netherlands+pakistan with php-laravel+javascript. `cv/master.json` in git is the owner's. `tests/fixtures/owner-golden.json` pins the owner's letters and filter results; a change that alters them must be deliberate.
- The Chrome extension may type prepared values into empty form fields when the user clicks "Fill this form". It never overwrites a filled field, never clicks a button and never submits a form.
- Prefer public APIs over scraping, and pace requests (`src/sources/http.ts` `sleep`) so no site blocks the bot. Never automate logins, account creation or CAPTCHAs.
- Every new feature or edit ships with tests in the same change:
  - Backend: `tests/*.test.ts` (node:test), run with `npm test` (database `job_bot_test_bot`).
  - Frontend: `web/tests/` (vitest), run with `npm run test:web` (database `job_bot_test`).
  - Tests must never touch the real `job_bot` database. Network calls are mocked (`mockFetch` in tests/helpers.ts, `tests/fixtures/fake-fetch.mjs` for CLI subprocesses), and Claude is replaced by `tests/fixtures/fake-claude.mjs` via `JOB_BOT_CLAUDE`. API providers (OpenAI, Anthropic, ...) are only ever reached through mocked fetch with a dummy key.
- Run one test file at a time while working (`node --test tests/x.test.ts` with the test DATABASE_URL, or `npx vitest run <file>` in web/), and avoid overlapping full runs.
- Everything in the project is written in English: code, comments, UI text, docs (README, ROADMAP), commit messages and PR descriptions.
- The AI provider is `config.json` `ai.provider`: `claude-cli` (default) or `api`, any OpenAI-compatible API with one key (`src/ai-providers.ts`, presets in `src/ai-presets.ts`, which the dashboard's Settings page imports). The key is `AI_API_KEY` in the environment (`.env`) only, never config.json, and never appears in logs, error messages or the dashboard (which shows only the variable name and the detected provider).
- The CV may only be re-framed, never given skills or claims that are not in `cv/master.json` (tests/cv.test.ts checks this).

## Project overview for Claude

A quick map for a new session. README.md has the features in full; docs/README.md is the doc index (install guides per OS, configuration, CV and profile, AI, daily use, troubleshooting, updating).

### What it does

Finds software jobs for the user's target countries (onsite, with or without a visa) and remote jobs open to where they live; filters and scores them against `cv/master.json`; prepares a CV version, cover letter, CV summary, form answers, interview prep and follow-ups; tracks applications. Hard rules (details under Rules): it never applies or submits anything, CVs only re-frame true facts, everything is English, every change ships with tests.

### Architecture map

- **CLI** `src/cli.ts`: parses flags, holds the command registry and the help text, applies migrations before every command that uses the DB (not `setup`, `settings:check`, `settings:save`), and runs `dedupe()` after commands that add jobs or change status.
- **Commands** `src/commands/<name>.ts`: one file per command or small group (`fetch.ts` has fetch + rescore, `prepare.ts` has prepare, letter, summary, letter:pdf, `cv.ts` has the CV commands, `task.ts` runs queued dashboard tasks, `setup.ts` the wizard).
- **Settings** `src/settings.ts`: zod schemas for `config.json` and `cv/applicant.json` (the source of truth for every setting); `src/config.ts` `config` is the CLI's copy of config.json, read on first use, not on import (logic takes settings as a parameter, `cfg`, e.g. `scoreJob(job, cfg)`), and `src/cli.ts` validates it before every command not in `NO_CONFIG`; `src/profile.ts` builds the profile (applicant + master CV fallbacks) and the visa / remote-from rules. `src/regions.ts` turns the remote-from country into the remote region allow / deny / flag patterns (config.json's own patterns, when set, win).
- **Sources** `src/sources/`: `index.ts` the ATS adapters (`fetchCompany`), `boards.ts` Himalayas, Remotive, RemoteOK, Arbeitnow, Adzuna (`BOARDS`), `linkedin.ts` guest search, `open.ts` dead-link check, `http.ts` `getJson` / `getText` with retry, ETag cache and the shared `sleep`.
- **Matching** `src/match.ts`: `scoreJob()` (location, title, age, language, visa, keyword score) and `pickCluster()`; `src/salary.ts`, `src/ats.ts` (CV keyword check), `src/sponsors.ts` (IND register), `src/discover.ts`.
- **AI** `src/ai.ts` prompts and output schemas (review, letter, CV summary, answers, interview prep, follow-up); `src/ai-providers.ts` `askAi()` sends them to the Claude CLI or an OpenAI-compatible API; `src/ai-presets.ts` the API presets. Template fallbacks: `src/cover.ts`, `src/followup.ts`.
- **CV** `src/cv/`: `profiles.ts` per-cluster framings (the owner's), `versions.ts` versioning and one-off CVs, `render.ts` HTML to PDF (CV and letter) via system Chrome.
- **DB** `src/db.ts` (pool, upsert, status changes, dedupe, `withLock`), `src/types.ts` row types shared with the dashboard, `src/migrate.ts` + `src/migrations/NNN_name.sql`.
- **Task queue** `src/tasks.ts` (table `tasks`, timeouts and CLI arguments per kind, claim / finish / fail), `TaskKind` in `src/types.ts`; the dashboard enqueues with `web/lib/tasks.ts` `enqueueTask` and starts a detached `task:run <id>` through `web/lib/bot.ts` `spawnBot`; `src/commands/task.ts` runs the normal CLI command for the row.
- **Dashboard** `web/` (Next.js 16, its own package.json): `app/` pages, `app/actions.ts` and `app/settings/actions.ts` server actions, `app/api/*` routes (import, cv, jobs lookup, letter, tasks, bayt-script); `lib/db.ts` queries; `lib/settings*.ts`, `lib/market.ts`, `lib/profile.ts`, `lib/contacts.ts`, `lib/currencies.ts`, `lib/skips.ts` read files and add dashboard presentation on top of the bot's own rules, imported from `../src`; `proxy.ts` refuses non-localhost hosts. The dashboard reads the DB directly and applies pending migrations once at start (`web/instrumentation.ts` → `bot migrate`, via `web/lib/migrate.ts`). `cvFileName`/`cvPath` live in `web/lib/cv-templates.ts`; the settings file paths (`configFile`/`applicantFile`/`masterFile`, honouring `JOB_BOT_*` overrides) in `src/settings.ts`, which `web/lib/settings.ts` calls with the dashboard's `BOT_ROOT`.
- **Extension** `extension/` (Manifest V3, plain JS): popup, side panel and form fill; `web/lib/extension.ts` trusts only its pinned id.
- **Daily run and OS support** `src/commands/daily.ts` (`bot daily`: fetch, check:open, ai:score, notification, backup; logs to data/fetch.log), `src/commands/schedule.ts` (`bot schedule:print`: launchd, systemd/cron, Task Scheduler), `src/backup.ts` (`bot backup`), `src/notify.ts` (osascript / terminal-notifier, notify-send, PowerShell toast). Everything OS-specific takes an injectable `platform` (and file check / runner), so the Linux and Windows paths are tested on any OS.
- **Scripts** `scripts/daily-fetch.sh` (thin zsh wrapper for launchd: sets PATH, runs `bot daily`), `backup-db.sh` (wrapper for `bot backup`), `run-tests.mjs` (`npm test`), `install-hooks.mjs` (`prepare`), `create-test-db.mjs`, `bayt-collect.js`.

### Running things

- Test databases, once: `npm run test:db -- job_bot_test_bot job_bot_test` (the names are required; the script only accepts `job_bot_test[_bot][_suffix]`). In a parallel worktree use suffixed ones, e.g. `npm run test:db -- job_bot_test_bot_wt1 job_bot_test_wt1` with `BOT_TEST_DB=job_bot_test_bot_wt1` and `WEB_TEST_DB=job_bot_test_wt1`.
- One backend file: `DATABASE_URL=postgres://postgres@127.0.0.1:5432/job_bot_test_bot node --no-warnings --test tests/match.test.ts`. `tests/helpers.ts` refuses any other database, and sets `JOB_BOT_NOTIFY=off`, `JOB_BOT_APPLICANT=tests/fixtures/applicant-owner.json` and a temp `JOB_BOT_HTTP_CACHE`.
- One dashboard file: `cd web && npx vitest run tests/lib/db.test.ts` (vitest sets `DATABASE_URL` from `WEB_TEST_DB`, default `job_bot_test`). Dashboard DB tests only touch rows with the `webtest:` id prefix (`web/tests/helpers/db.ts`).
- Cross-platform: the bot runs on macOS (the owner's), Linux and Windows. npm scripts must not use shell syntax (no `VAR=x cmd`, no single quotes; `tests/scripts.test.ts` checks), child processes use argument arrays plus `windowsHide: true`, and paths use `path.join`, `os.tmpdir()` and `os.homedir()`. CI runs the database-free tests on `windows-latest` too.
- Fakes: `mockFetch(routes)` in `tests/helpers.ts` replaces global fetch in-process; `tests/fixtures/fake-fetch.mjs` (`node --import`, `FAKE_FETCH` JSON) does it for CLI subprocesses; `tests/fixtures/fake-claude.mjs` via `JOB_BOT_CLAUDE` answers with `FAKE_CLAUDE_OUT`, fails with `FAKE_CLAUDE_FAIL` and logs to `FAKE_CLAUDE_LOG`.
- Checks: `npx biome ci .` (Biome also formats Markdown tables; `npx biome check --write <file>` fixes them), `npm run typecheck` (bot and dashboard). Read-only CLI checks that need no DB: `npm run bot` (help), `npm run bot -- settings:check --kind config --file config.json`.

### Conventions

- The dashboard imports bot logic from `../src` instead of copying it (Turbopack's root is the repo, `web/next.config.ts`; `.ts` extensions, since the bot's tests load `web/lib/db.ts` in plain Node). It may only import modules that do nothing on import: no DB pool, no `config.json`, no file reads. Client components only modules with no runtime imports: `src/types.ts` (types and shared constant lists: `SKIP_REASONS`, `ATS`, `REMOTE_BOARDS`, `CV_VERSION`, `FEEDBACK_CAP`, `KEEP_FINISHED_DAYS`), `src/ai-presets.ts`, `src/contacts.ts`, `src/followup.ts`, `src/cv/templates/list.ts`; server code also `src/profile.ts`, `src/settings.ts`, `src/currencies.ts`. Never `src/db.ts`, `src/tasks.ts`, `src/config.ts` or commands. Logic that needs settings takes them as a parameter (`cfg`), never `config` directly, if the dashboard may need it. One copy remains: the task queue's SQL in `web/lib/tasks.ts` (enqueue, stale and dead-worker checks), because the bot's versions run on the bot's own pool (`src/db.ts`); keep the two in step.
- Migrations are append-only: add the next `NNN_name.sql`, idempotent where possible, never edit a committed one; update `src/types.ts` with new columns.
- Every setting is in the zod schemas in `src/settings.ts`. A new key also needs `web/lib/settings-form.ts` (`CONFIG_FIELDS`) if the Settings page edits it, the setup wizard if a new user must answer it, and a row in docs/configuration.md.
- `tests/fixtures/owner-golden.json` pins the owner's template letters, follow-ups and filter results against `config.default.json` and `cv/master.json`; update it only for a deliberate change.

### Machine limits

- One `tsc` / `npm run typecheck` at a time, run by the main session only; subagents verify with single test files.
- Never run full backend and dashboard suites in parallel, or while a typecheck runs (they share Postgres and the CPU).
- Never touch the real `job_bot` database from tests or experiments, and do not run `fetch` / `ai:score` against it unless asked.

### Where new work usually goes

- New command: `src/commands/<name>.ts`, registered in `src/cli.ts` (map, help text, `NO_DB` / dedupe lists if relevant), plus the README CLI reference.
- New source: an ATS adapter in `src/sources/index.ts` (and the `ATS` list in `src/settings.ts` and `web/lib/settings-form.ts`) or a board in `src/sources/boards.ts` `BOARDS`.
- Filter or scoring change: `src/match.ts` (users then run `rescore`); check owner-golden.
- New AI feature: prompt and schema in `src/ai.ts`, called through `askAi(prompt, schema, 'score' | 'letter', system)`.
- New dashboard background action: a `TaskKind` in `src/types.ts`, its timeout and CLI arguments in `src/tasks.ts` (`TASK_TIMEOUT_MS`, `cliArgs`), its label in `web/lib/tasks.ts` (`TASK_LABEL`), and a server action in `web/app/actions.ts` that calls `enqueueTask`.
- Docs: README (features, CLI reference), docs/README.md (index), docs/install/{macos,linux,windows}.md (setup per OS), docs/configuration.md (every setting), docs/your-cv-and-profile.md, docs/ai.md, docs/daily-use.md, docs/troubleshooting.md, docs/updating.md, ROADMAP.md (done / open). Keep the three install guides in step with each other.
