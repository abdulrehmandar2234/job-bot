# Roadmap: improvement ideas

Ideas for making job-bot more useful and easier to maintain, grouped by area and roughly ordered by value. None of them change the core rule: the bot never applies on its own.

## Features

### High value

1. **Follow-up reminders.** Flag jobs that have been `applied` for 7–10 days with no update, and draft a short follow-up message for the recruiter (you send it yourself). Show a "Needs follow-up" tab on the dashboard.
2. **Funnel analytics page.** Show response and interview rates by source, country, CV version and AI verdict. It tells you which CV versions and sources actually get replies, so you can focus on those.
3. **Interview prep.** When a job moves to `interview`, generate likely technical and behavioural questions from the job description and your CV, a short company brief, and questions to ask them.
4. **More API sources, especially for the Netherlands.**
   - Workday career sites (many large UAE/Saudi employers use them) have a public JSON endpoint per company.
   - Arbeitnow (free public API, EU jobs) and Adzuna (free API key, has an NL index) for Dutch roles.
   - Check each one's terms and rate limits before adding it.
5. **Instant alerts for strong matches.** Send a macOS notification (or a Telegram/WhatsApp message) as soon as the AI marks a fresh job `strong`, instead of waiting for the morning summary. Early applicants get more replies.
6. **Settings page.** Edit filters, companies, keywords and `applicant.json` from the dashboard instead of hand-editing JSON. Run `rescore` automatically after saving.

### Medium value

7. **Learn from skips.** Ask for a reason when you skip a job (stack, seniority, salary, company) and use the patterns to tune `roleExclude` or the score weights.
8. **Dead-link check.** Before preparing a job, check that the posting is still open, and mark closed ones `expired`.
9. **ATS keyword check.** Compare the chosen CV version with the job description and list important keywords you genuinely have but the CV does not show, so you can choose a better version.
10. **Salary extraction.** Pull salary ranges out of descriptions when present, show them on the card, and allow filtering by them.
11. **Contacts per job.** Store recruiter and referral contacts with the job, and remind you to ask for a referral before applying to companies where you know someone.
12. **Chrome extension instead of the bookmarklet.** One click "Send to job-bot" from any job page (Bayt, GulfTalent, NaukriGulf, company sites), plus a side panel that shows the prepared letter and answers for copying. It must only help you copy; it must not fill in or submit forms.

## Code and architecture

1. **Background task queue for long operations.** `fetchNow` holds a server action open for up to 20 minutes. Add a `tasks` table with a worker (or Postgres `LISTEN/NOTIFY`), return at once, and show progress on the dashboard. Prepare and AI review would also stop blocking the page.
2. **One shared type definition.** The `Job` type exists twice (`src/db.ts` and `web/lib/db.ts`). Move shared types into one module both sides import, so a new column cannot drift between them.
3. **Validate `config.json` and `applicant.json` at startup** (for example with zod) and give a clear error, instead of failing later deep inside a fetch.
4. **Split `src/cli.ts`.** Move each command into its own file under `src/commands/`, so the CLI file is just a registry.
5. **Versioned migrations.** `schema.sql` re-runs `ALTER ... IF NOT EXISTS` on every start. That works now, but a small `schema_migrations` table with numbered files will be safer once columns need renaming or backfills.
6. **HTTP politeness and caching.** Add retry with exponential backoff and jitter to the shared HTTP helper, and send `If-None-Match`/`If-Modified-Since` where boards support it, so repeated fetches make fewer full requests.
7. **Database backups.** A daily `pg_dump` of `job_bot` into `data/backups/`, keeping the last 14. Your application history is the most valuable data here.

## Quality and tooling

1. **GitHub Actions CI.** Run `npm run test:all` with a Postgres service container on every push. Private repos get free monthly Actions minutes.
2. **Coverage report.** Add `--experimental-test-coverage` (node:test) and `@vitest/coverage-v8` to find untested code.
3. **Close the known test gaps:** `web/app/page.tsx` and `layout.tsx`, `runBot` actually spawning the CLI, `CopyButton` when the clipboard write fails, the browser logic in `scripts/bayt-collect.js`, and the `fetch` command end to end with mocked sources.
4. **Lint and format** (Biome or ESLint + Prettier) and a pre-commit hook that runs them.
5. **Show fetch errors on the dashboard.** `fetch_runs.errors` is stored but only visible in the log. A small "Last fetch" panel would show a broken board early.

## Privacy

- The repo is private because it contains your CV PDFs and `cv/master.json` (phone, email). If you ever want to make the code public, move personal CV data to a gitignored folder first and keep only an example CV in the repo.
