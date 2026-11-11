# Talaash dashboard

The local web dashboard of [talaash](../README.md): the job list, job pages, Settings and Analytics. It is a Next.js app that reads the bot's PostgreSQL database directly and starts bot commands (prepare, letters, AI reviews, ...) in the background through the CLI.

It only answers on `127.0.0.1` and has no login, so it is meant for your own computer only: never deploy it or expose it to a network.

## Run it

From the project root (not this folder), after the setup in the [install guides](../docs/README.md#1-install-it-on-your-computer):

```bash
npm install && npm --prefix web install   # once; the dashboard also needs the root packages
npm run web                               # http://localhost:3100
```

It needs `DATABASE_URL` in `web/.env.local` (the setup wizard can write it). On start it applies pending database migrations (`instrumentation.ts` runs `npm run bot -- migrate`). Port 3100 already in use? Stop the other dashboard, or run `npm --prefix web run dev -- -p 3200` and set that address in the Chrome extension's options.

How to use it: [docs/daily-use.md](../docs/daily-use.md).

## Layout

- `app/`: pages (`page.tsx` the job list, `jobs/[id]` the job page, `settings`, `analytics`), server actions (`actions.ts`, `settings/actions.ts`) and API routes (`api/`: import from the extension, CV and letter files, job lookup, task status, the Bayt script).
- `components/`: React components; `form-state.tsx` and `action-form.tsx` handle form results and errors.
- `lib/`: database queries (`db.ts`), settings, profile and market rules (imported from the bot's `../src`, never copied), the background task queue (`tasks.ts`, `bot.ts`), the list URL and remembered filters.
- `proxy.ts`: refuses requests for any host other than localhost, and restores saved filters.
- `tests/`: vitest tests.

The rules for importing bot code from `../src` (only modules that do nothing on import) are in the root [CLAUDE.md](../CLAUDE.md#conventions).

## Tests and checks

From the project root:

```bash
npm run test:web                      # all dashboard tests (database job_bot_test)
cd web && npx vitest run tests/lib/db.test.ts   # one file
npm run typecheck                     # the bot and the dashboard
npm --prefix web run build            # the production build CI checks
```

Database tests only touch rows whose id starts with `webtest:`, and never the real `job_bot` database. Creating the test databases: [CONTRIBUTING.md](../CONTRIBUTING.md).
