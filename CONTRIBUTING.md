# Contributing to Talaash

Thanks for helping. Talaash is [MIT licensed](LICENSE): by opening a pull request you agree that your contribution is released under the same license. Anyone can propose a change: fork the repository, make the change on a branch, and open a pull request. Only the maintainer merges, after review.

## Ground rules

These are the project's hard rules. A pull request that breaks one is not merged.

- **The bot never applies.** It finds, scores and prepares (CV, cover letter, form answers). The user applies themselves. The Chrome extension may type into empty form fields when the user clicks; it never clicks a button or submits a form.
- **Only true facts.** Every AI prompt and CV change may only re-frame what is in the user's `cv/master.json`. Never add skills, employers, numbers or claims the CV does not show.
- **Polite to job sites.** Prefer public APIs, pace requests (`src/sources/http.ts`), and stop on rate limits. No logins, account creation or CAPTCHA solving.
- **Nothing personal in commits.** Never commit your own `cv/applicant.json`, `.env`, `web/.env.local`, API keys, generated CVs (`cv/versions/`), `applications/` or `data/`. They are gitignored; keep it that way. Use the fictional `cv/master.example.json` / `cv/applicant.example.json` in tests.
- **Tests with every change.** Backend: `tests/*.test.ts` (node:test). Dashboard: `web/tests/` (vitest).
- **English** in code, comments, UI text, docs, commit messages and pull requests.

`CLAUDE.md` has the full list of conventions and an architecture map.

## Set up a development copy

1. Fork the repository on GitHub, then clone your fork:

   ```bash
   git clone https://github.com/<your-user>/talaash.git
   cd talaash
   npm install
   npm --prefix web install
   ```

   `npm install` also installs the git pre-commit hook, which runs Biome on the files you stage.

2. Install PostgreSQL and the rest as in your OS's guide: [macOS](docs/install/macos.md), [Linux](docs/install/linux.md) or [Windows](docs/install/windows.md). You don't need your own CV or an AI provider to run the tests: they use fictional data, a fake Claude CLI and mocked network calls.

3. Create the two test databases. The tests never touch your real `job_bot` database:

   ```bash
   npm run test:db -- job_bot_test_bot job_bot_test
   ```

## Before you open a pull request

Run, from the project folder:

```bash
npx biome ci .          # lint and format
npm run typecheck       # TypeScript for the bot and the dashboard
npm test                # backend tests
npm run test:web        # dashboard tests
```

While working, run one file at a time, for example `npm test -- tests/match.test.ts` or `cd web && npx vitest run tests/lib/db.test.ts`.

- **Schema changes:** add the next numbered file in `src/migrations/`. Never edit a migration that is already on `main`.
- **New settings:** add them to the zod schema in `src/settings.ts`, to `config.default.json` if they need a default, to the Settings page if users edit them there, and to [docs/configuration.md](docs/configuration.md). Your own `config.json` is gitignored: never commit it.
- **New presets:** a market or stack is one JSON file in `presets/markets/` or `presets/stacks/` (copy an existing one). `tests/presets.test.ts` validates every preset.
- **Logic copied into the dashboard:** if you copy bot logic into `web/`, add a parity test, as the existing ones do.
- **Docs:** update the pages in `docs/` when behaviour changes (a feature in `docs/features.md`, a command in `docs/cli.md`, a setting in `docs/configuration.md`), and README.md only for its short overview. The three install guides must stay in step with each other. A new page also goes in the site's sidebar (`docs/.vitepress/config.mts`); `npm --prefix docs install` once, then `npm run docs:build` checks for dead links, as CI does.

CI runs Biome, the typecheck and both suites on Ubuntu with PostgreSQL, plus the database-free tests on Windows.

## Pull requests

- **One topic per pull request**, on a branch named like `fix/…` or `feat/…`.
- **Description:** say what changed and why, and how you tested it. The template asks for this.
- **Screenshots** help for dashboard or extension changes.
- **Discuss larger changes first:** for a new job source, a new AI provider or a schema redesign, open an issue first so we can agree on the approach.

## Reporting bugs

Open an issue with:

- what you did, what you expected and what happened;
- your OS, your Node version (`node --version`) and the AI provider;
- the relevant lines of `data/fetch.log` or the terminal output.

Remove personal data (CV text, emails, keys) before you paste logs.
