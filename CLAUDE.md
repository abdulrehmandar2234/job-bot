# job-bot

Local job-search helper: Node CLI bot (`src/`, TypeScript run directly by Node 24+) and a Next.js dashboard (`web/`), both on the local Postgres DB `job_bot`. See README.md for features, architecture and usage, and ROADMAP.md for what is done and what is still open.

## Rules

- The bot never applies to a job. It finds, scores and prepares (CV, cover letter, form answers). The user applies themselves.
- Nothing personal is hardcoded. Name, contact, location, languages and letter sentences come from the profile (`cv/applicant.json`, `src/profile.ts`, falling back to `cv/master.json`); target countries, visa needs and the remote-from country from `config.json`. Prompts say "the candidate", never he/his. The dashboard mirrors the profile rules in `web/lib/market.ts` (parity test in `web/tests/lib/market.test.ts`).
- `config.json` and `cv/master.json` in git are the owner's. `tests/fixtures/owner-golden.json` pins the owner's letters and filter results; a change that alters them must be deliberate.
- Prefer public APIs over scraping, and pace requests (`src/sources/http.ts` `sleep`) so no site blocks the bot. Never automate logins, account creation or CAPTCHAs.
- Every new feature or edit ships with tests in the same change:
  - Backend: `tests/*.test.ts` (node:test), run with `npm test` (database `job_bot_test_bot`).
  - Frontend: `web/tests/` (vitest), run with `npm run test:web` (database `job_bot_test`).
  - Tests must never touch the real `job_bot` database. Network calls are mocked (`mockFetch` in tests/helpers.ts), and Claude is replaced by `tests/fixtures/fake-claude.mjs` via `JOB_BOT_CLAUDE`.
- Run one test file at a time while working (`node --test tests/x.test.ts` with the test DATABASE_URL, or `npx vitest run <file>` in web/), and avoid overlapping full runs.
- Everything in the project is written in English: code, comments, UI text, docs (README, ROADMAP), commit messages and PR descriptions.
- The CV may only be re-framed, never given skills or claims that are not in `cv/master.json` (tests/cv.test.ts checks this).
