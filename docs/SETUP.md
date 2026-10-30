# Setting up job-bot

This guide takes you from a fresh Mac to a running job-bot: the bot CLI, the dashboard, the daily fetch and the Chrome extension. It assumes you are a developer who has not seen the project before. Read [README.md](../README.md) for what the bot does and how it works; this file is only about installing and configuring it.

job-bot **never applies on your behalf**. It finds, filters, scores and prepares (CV, cover letter, form answers). You review everything and submit every application yourself.

Contents:

1. [Prerequisites](#1-prerequisites)
2. [Get the code and install](#2-get-the-code-and-install)
3. [Create the database and the env files](#3-create-the-database-and-the-env-files)
4. [Your CV: `cv/master.json`](#4-your-cv-cvmasterjson)
5. [The setup wizard: `npm run bot -- setup`](#5-the-setup-wizard-npm-run-bot----setup)
6. [Your profile: `cv/applicant.json`](#6-your-profile-cvapplicantjson)
7. [Configuration reference: `config.json`](#7-configuration-reference-configjson)
8. [Choosing an AI provider](#8-choosing-an-ai-provider)
9. [First run](#9-first-run)
10. [The daily fetch (launchd)](#10-the-daily-fetch-launchd)
11. [The Chrome extension](#11-the-chrome-extension)
12. [Updating](#12-updating)
13. [Troubleshooting](#13-troubleshooting)
14. [Privacy: what stays on your Mac](#14-privacy-what-stays-on-your-mac)

---

## 1. Prerequisites

| What                                         | Required?                           | Why                                                                                                                                                                             | Check                                                 |
| -------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **macOS**                                    | for the daily job and notifications | The daily fetch uses launchd, notifications use `osascript`. The CLI and dashboard also run on Linux, but this guide is for macOS.                                              |                                                       |
| **Node.js 24 or newer**                      | yes                                 | The bot runs its TypeScript directly with Node (no build step); `package.json` has `"engines": { "node": ">=24" }`.                                                             | `node --version`                                      |
| **PostgreSQL** (15 or newer; CI uses 18)     | yes                                 | One local database, `job_bot`, shared by the bot and the dashboard.                                                                                                             | `psql --version`                                      |
| **Chrome headless shell** (or Google Chrome) | yes, for CV and letter PDFs         | Install once with `npx playwright-core install chromium-headless-shell`: a plain binary, so no window or Dock icon. Without it, an installed Google Chrome or Chromium is used. | `npx playwright-core install chromium-headless-shell` |
| **Git**                                      | yes                                 | To clone and update.                                                                                                                                                            | `git --version`                                       |
| **Claude Code CLI**, signed in               | optional                            | The default AI provider. Without it, use one API key instead (section 8), or turn the AI off.                                                                                   | `which claude`                                        |
| **terminal-notifier**                        | optional                            | Makes the "strong match" notification clickable (it opens the job on the dashboard). Without it, `osascript` shows a plain notification.                                        | `which terminal-notifier`                             |

Install what is missing:

```bash
# Node 24 (Homebrew; nvm or fnm also work for the CLI, but see the launchd note in section 10)
brew install node@24        # follow brew's hint to put it on your PATH

# PostgreSQL: either DBngin (a free menu-bar app, https://dbngin.com) or Homebrew
brew install postgresql@17 && brew services start postgresql@17

# Optional
brew install terminal-notifier
```

**DBngin:** create a PostgreSQL server (15 or newer) on port `5432` and start it. Its default superuser is `postgres` with no password, which is what the examples here use. Its command-line tools live in `/Users/Shared/DBngin/postgresql/<version>/bin/` (add that folder to your PATH, or call `createdb` with its full path).

**Homebrew PostgreSQL:** its superuser is your macOS user name, not `postgres`. The test-database script (`scripts/create-test-db.mjs`) and the backup script (`scripts/backup-db.sh`) connect as `postgres`, so create that role once:

```bash
createuser -s postgres
```

**Claude Code CLI:** install it as described in the [Claude Code docs](https://docs.claude.com/en/docs/claude-code), run `claude` once and sign in. Then note its path for the setup wizard: `which claude` (the native installer puts it in `~/.local/bin/claude`).

## 2. Get the code and install

```bash
git clone <this repository> ~/job-bot
cd ~/job-bot
npm install                 # the bot; also points git at .githooks/ (Biome pre-commit check)
npm --prefix web install    # the dashboard (its own package.json and lockfile)
```

Keep the folder **outside `~/Desktop`, `~/Documents` and `~/Downloads`** if you want the daily fetch: macOS privacy protection does not let a launchd job read those folders.

## 3. Create the database and the env files

### The database

```bash
createdb -h 127.0.0.1 -U postgres job_bot
```

You do not create any tables. Every bot command that uses the database first applies the SQL files in `src/migrations/` that the database has not run yet (see [Updating](#12-updating)).

### `.env` (the bot)

The bot reads `.env` in the project root (`npm run bot` uses `node --env-file-if-exists=.env`). The dashboard's background tasks start the bot the same way, so they read the same file. Start from the example:

```bash
cp .env.example .env
```

Then add `DATABASE_URL` and whatever else you need:

```bash
DATABASE_URL=postgres://postgres@127.0.0.1:5432/job_bot
```

Every variable the bot reads:

| Variable                             | Required?                                                                 | What it is                                                                                                                                                                                                   | Example                                                        |
| ------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `DATABASE_URL`                       | **yes** (every command except `setup`, `settings:check`, `settings:save`) | Postgres connection string of the `job_bot` database. The bot stops with `DATABASE_URL missing — add it to .env` without it.                                                                                 | `postgres://postgres@127.0.0.1:5432/job_bot`                   |
| `AI_API_KEY`                         | only with `"ai": { "provider": "api" }`                                   | The one API key for an OpenAI-compatible provider. The provider is detected from its prefix unless `ai.api.preset` says otherwise (section 8). Never put it in `config.json`. Not needed for a local Ollama. | `AI_API_KEY=sk-ant-...`                                        |
| `AI_BASE_URL`                        | no                                                                        | Any other OpenAI-compatible endpoint (a proxy, a self-hosted server). Wins over the preset's URL and `ai.api.baseUrl`.                                                                                       | `https://example.com/v1`                                       |
| `OPENAI_API_KEY`, `DEEPSEEK_API_KEY` | no (older names)                                                          | Read only when `AI_API_KEY` is not set, for configs from before the single key existed.                                                                                                                      |                                                                |
| `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`    | no                                                                        | Your own free Adzuna API credentials (register at [developer.adzuna.com](https://developer.adzuna.com)). Without them the `adzuna` board is skipped with one log line.                                       | `ADZUNA_APP_ID=1a2b3c4d`                                       |
| `JOB_BOT_CONFIG`                     | no                                                                        | Use another file instead of `config.json`. Meant for tests: `discover --add` and parts of the dashboard still read the project's own files.                                                                  | `/tmp/config.test.json`                                        |
| `JOB_BOT_APPLICANT`                  | no                                                                        | Use another file instead of `cv/applicant.json` (same caveat).                                                                                                                                               |                                                                |
| `JOB_BOT_MASTER`                     | no                                                                        | Use another file instead of `cv/master.json` (same caveat).                                                                                                                                                  |                                                                |
| `JOB_BOT_CHROME`                     | no                                                                        | Chrome executable; wins over `config.json` `chromePath`.                                                                                                                                                     | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` |
| `JOB_BOT_CLAUDE`                     | no (tests)                                                                | Another executable in place of `ai.claudePath`. Tests point it at `tests/fixtures/fake-claude.mjs`.                                                                                                          |                                                                |
| `JOB_BOT_NOTIFY`                     | no                                                                        | `off` disables the strong-match notifications; any other value is a program that gets the title, message and URL as arguments.                                                                               | `off`                                                          |
| `JOB_BOT_HTTP_CACHE`                 | no                                                                        | Folder for the HTTP cache (ETag / Last-Modified). Default `data/http-cache`.                                                                                                                                 |                                                                |

The backup script (`scripts/backup-db.sh`, run by the daily fetch) is a shell script and does **not** read `.env`. It takes `PGHOST` / `PGPORT` / `PGUSER` (defaults `127.0.0.1`, `5432`, `postgres`) and `JOB_BOT_BACKUP_DB` / `JOB_BOT_BACKUP_DIR` / `JOB_BOT_BACKUP_KEEP` (defaults `job_bot`, `data/backups`, `14`) from the environment it is started in. `BOT_TEST_DB` and `WEB_TEST_DB` are only for the test suites (see `CLAUDE.md`).

### `web/.env.local` (the dashboard)

Next.js reads `web/.env.local`. The dashboard needs the same database:

```bash
DATABASE_URL=postgres://postgres@127.0.0.1:5432/job_bot
```

| Variable                              | Required? | What it is                                                                                                                           |
| ------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                        | **yes**   | The same database as the bot's `.env`.                                                                                               |
| `JOB_BOT_EXTENSION_ID`                | no        | Only if you replaced the key in `extension/manifest.json`: the new extension id (see [extension/README.md](../extension/README.md)). |
| `JOB_BOT_CONFIG`, `JOB_BOT_APPLICANT` | no        | If you set them for the bot, set the same values here, so the Settings page edits the same files.                                    |
| `JOB_BOT_ENV_FILE`                    | no        | Where the Settings page looks for the bot's env file (to say whether `AI_API_KEY` is set). Default: the project's `.env`.            |

Both env files are gitignored.

## 4. Your CV: `cv/master.json`

This file is your CV as data, and the only source of truth about you: every CV PDF, every AI prompt (fit review, letter, CV summary, form answers, interview prep, follow-ups) and the keyword match read it. The bot only re-orders and re-frames what is here; it never adds a skill, employer, number or claim.

```bash
cp cv/master.example.json cv/master.json
```

Then replace the fictional Jane Doe with yourself. The file is not schema-validated like `config.json`: every field below must be present with the right type, or rendering the PDF fails (`projects` and `education` may be empty arrays).

| Field              | Type                        | What it is                                                                                                                                | Example                                                                                            |
| ------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `name`             | string                      | Your name, the CV heading and the letter header. Also the fallback for `fullName` in your profile.                                        | `"Jane Doe"`                                                                                       |
| `title`            | string                      | Your headline under the name.                                                                                                             | `"Full Stack Engineer"`                                                                            |
| `contact.phone`    | string                      | Phone, international format. Fallback for the profile's `phone`.                                                                          | `"+351 900 000 000"`                                                                               |
| `contact.email`    | string                      | Email. Fallback for the profile's `email`.                                                                                                | `"jane.doe@example.com"`                                                                           |
| `contact.location` | string                      | "City, Country" as shown on the CV. Last fallback for your location.                                                                      | `"Lisbon, Portugal"`                                                                               |
| `contact.linkedin` | string                      | Full LinkedIn URL. Fallback for the profile's `linkedin`.                                                                                 | `"https://www.linkedin.com/in/jane-doe/"`                                                          |
| `summary`          | string                      | The paragraph at the top of the CV. The AI's per-job CV summary is written "in the voice of your current summary", so make this one good. | 2–4 sentences                                                                                      |
| `skills`           | array of `{ group, items }` | Skill groups, each a name and a list of skills. **A job's skill counts as yours only when it is listed here** (section 7, scoring).       | `{ "group": "Databases & ORMs", "items": ["PostgreSQL", "Prisma"] }`                               |
| `experience`       | array                       | One entry per job, newest first: `role`, `company`, `location`, `dates`, `tags` (array of strings), `bullets` (array of strings).         | see the example file                                                                               |
| `projects`         | array                       | `name`, `url` (a full URL; shown without `https://`), `tags` (array), `text` (one or two sentences).                                      |                                                                                                    |
| `education`        | array                       | `school`, `degree`, `dates`.                                                                                                              | `{ "school": "University of Example", "degree": "BSc, Computer Science", "dates": "2016 — 2020" }` |

Good practice:

- **Bullets:** start with a verb in the past tense ("Built", "Designed", "Cut"), one achievement per bullet, with a number where you have a true one ("to 50,000 monthly users"). The **first bullet of each job stays first** in every CV version (it introduces the role); the others may be re-ordered per version, so make each one stand on its own.
- **Dates:** one format everywhere, e.g. `"Jan 2023 — Present"`, `"Jun 2020 — Dec 2022"`, `"2016 — 2020"`. They are printed as you write them.
- **Skills:** 4–7 groups with clear names. The built-in CV versions move groups called `Languages & Runtimes`, `Frameworks & Libraries`, `Databases & ORMs`, `APIs & Web`, `Testing & Practices` and `AI Tools & Agentic Development` to the front, so reuse those names where they fit. Use the common spelling of each skill (`Node.js`, `React.js`, `PostgreSQL`, `TypeScript`): the keyword match looks for patterns such as `node`, `react`, `postgres` in your skill items. Listing `MySQL` or `PostgreSQL` also proves "SQL".
- **Tags:** short lower-case words. Project `tags` decide which projects a CV version lists first: the built-in versions look for `laravel`, `fintech`, `mern`, `nest`, `next` and `ai`. Experience `tags` are stored with the CV but not used for ordering today.
- **Only true facts.** The AI may only use what is here, so anything missing here will never appear in a letter or answer.

Render it once you have run `npm run bot -- setup` (which sets the PDF file name):

```bash
npm run bot -- cv:default    # writes cv/default/<cvFileName>
```

You may also keep your original PDF in `cv/original/`; the bot never changes it.

> **The per-stack CV versions are the original author's.** `src/cv/profiles.ts` holds a headline and summary per stack cluster (`laravel`, `mern`, `next-nest`, ...) written for the author's CV. Keep `autoCvVersions: false` in `config.json` and do not use `prepare --cv <cluster>`, `cv:build` or `custom` until you have rewritten those profiles for yourself, or the PDF gets the author's headline and summary. `cv:tailor` (CV summary for one job) is safe: with `autoCvVersions: false` it starts from your default CV.

## 5. The setup wizard: `npm run bot -- setup`

```bash
npm run bot -- setup
```

The wizard fills in your profile (`cv/applicant.json`) and your target markets (`config.json`). It needs no database. Every question shows the current value in `[brackets]`: **Enter keeps it**, **`-` clears it**. A wrong answer (bad email, bad code, invalid regular expression) is asked again. At the end both files are validated against the schemas in `src/settings.ts`, and nothing is written unless both are valid and you say yes. Run it again whenever you like, or edit the same fields on the dashboard's Settings page (`/settings`).

Fill in `cv/master.json` first: the name, email, phone and LinkedIn defaults come from it.

**Your profile (`cv/applicant.json`)**

| #   | Question                                   | Saved as               | Notes                                                                                                                                                               |
| --- | ------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Full name                                  | `fullName`             | Default from `cv/master.json` `name`.                                                                                                                               |
| 2   | Email                                      | `email`                | Must look like an email.                                                                                                                                            |
| 3   | Phone                                      | `phone`                |                                                                                                                                                                     |
| 4   | LinkedIn URL                               | `linkedin`             | Must start with `http://` or `https://`.                                                                                                                            |
| 5   | City you live in                           | `city`                 |                                                                                                                                                                     |
| 6   | Country you live in                        | `country`              | Also the default "remote work from" country.                                                                                                                        |
| 7   | Its two-letter country code (ISO), e.g. PT | `countryCode`          | **Required**, saved upper-case. You never need a visa for a target country with this code.                                                                          |
| 8   | Your UTC offset, e.g. GMT+1                | `utcOffset`            | `GMT+5`, `GMT+0`, `UTC-3:30`. Used in remote-job letters and to judge Himalayas time-zone limits. If `currentLocation` is empty, it is set to "City, Country" here. |
| 9   | Languages you speak, comma-separated       | `languages`            | A posting that requires a language you list is not filtered out (Dutch, Arabic, German, French are checked).                                                        |
| 10  | Work authorisation (citizenship, permits)  | `workAuthorization`    | Free text for form answers and prompts.                                                                                                                             |
| 11  | Visa sponsorship, in your words            | `needsVisaSponsorship` | Free text for form answers.                                                                                                                                         |
| 12  | Willing to relocate?                       | `willingToRelocate`    | Text starting with "Yes" (or "Open to") puts relocation into letters.                                                                                               |

**Where you are looking (`config.json`)**

| #   | Question                                                                                                                                    | Saved as                                                    | Notes                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13  | Target countries for onsite jobs, two-letter codes                                                                                          | the keys of `countries`                                     | At least one, e.g. `NL, AE`. Countries you leave out are removed.                                                                                                               |
| 13a | `<code>`: country name                                                                                                                      | `countries.<code>.name`                                     | Required.                                                                                                                                                                       |
| 13b | `<code>`: location pattern (regular expression)                                                                                             | `countries.<code>.match`                                    | Default: the lower-case name. Add cities and spellings, e.g. `amsterdam\|rotterdam\|netherlands\|\bnl\b`.                                                                       |
| 13c | `<code>`: visa route                                                                                                                        | `countries.<code>.visa`                                     | `employer` (the employer arranges the permit) or `ind-register` (Netherlands: the company must be an IND recognised sponsor). Default `ind-register` for `NL`, else `employer`. |
| 13d | `<code>`: do you need a work visa there?                                                                                                    | `countries.<code>.needsVisa`                                | Default "n" for your own country code, else "y".                                                                                                                                |
| 14  | Also look for remote jobs?                                                                                                                  | `remote.enabled`                                            |                                                                                                                                                                                 |
| 14a | Remote work from which country                                                                                                              | `remote.from` and `linkedin.remoteFrom`                     | Only when remote is on. If `config.json` still names another country (a cloned config), the wizard proposes yours and shows the old one.                                        |
| 14b | Its two-letter code                                                                                                                         | `remote.fromCode`                                           | Himalayas only lists jobs open to this country.                                                                                                                                 |
| 14c | Remote regions that include you (regular expression)                                                                                        | `remote.allow`                                              | When you change country, the default becomes `worldwide\|anywhere\|global\|<your country>\|emea\|international`.                                                                |
| 14d | Remote regions that exclude you (regular expression)                                                                                        | `remote.deny`                                               | The default is the current list without your own country.                                                                                                                       |
| 15  | LinkedIn onsite search locations, comma-separated                                                                                           | `linkedin.locations`                                        | As you would type them in LinkedIn's location box. Default: the country names.                                                                                                  |
| 16  | Claude CLI or API key (claude-cli / api)                                                                                                    | `ai.provider`                                               | See section 8.                                                                                                                                                                  |
| 16a | (claude-cli) Path to the Claude Code CLI                                                                                                    | `ai.claudePath`                                             | The output of `which claude`.                                                                                                                                                   |
| 16b | (api) Which provider (`auto`, `openai`, `deepseek`, `anthropic`, `gemini`, `groq`, `openrouter`, `mistral`, `together`, `ollama`, `custom`) | `ai.api.preset`                                             | `auto` removes the preset, so it is detected from the key. The wizard **never asks for the key**: it reminds you to put `AI_API_KEY=...` in `.env`.                             |
| 16c | (custom only) base URL, model for scoring, model for writing                                                                                | `ai.api.baseUrl`, `ai.api.scoreModel`, `ai.api.letterModel` | An empty base URL means `AI_BASE_URL` in `.env`.                                                                                                                                |
| 17  | File name of your CV PDF                                                                                                                    | `cvFileName`                                                | Letters, digits, `_`, `.`, `-`, ending in `.pdf`. Default `<your_name>_resume.pdf`.                                                                                             |

Then it asks `Save cv/applicant.json and config.json? (y/n)`, lists any profile fields still missing, and suggests the next steps.

The wizard does **not** touch the rest of `config.json`. A clone still has the original author's companies, job-title rules and search keywords (UAE, Saudi Arabia and the Netherlands; Laravel / PHP / Node / React). Review section 7, at least `companies`, `roleInclude` / `roleExclude`, `linkedin.keywords` and `remote.himalayasQueries`.

## 6. Your profile: `cv/applicant.json`

The setup wizard or the Settings page creates it; `cv/applicant.example.json` shows a fictional person. It is gitignored. Every key is optional (a missing fact counts as unknown), extra keys are allowed and passed to the AI as they are, and the file is validated on every start.

For form answers, **`null` means unknown**: the AI then writes `[FILL: ...]` (highlighted) instead of guessing. Fill in what you are happy for the bot to state.

| Key                     | Type                                       | Used for                                                                                                                                                                                                                                                                                                                                                   | Example                                                                              |
| ----------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `_help`                 | string                                     | A note for humans; ignored.                                                                                                                                                                                                                                                                                                                                |                                                                                      |
| `fullName`              | string or null                             | Letter and follow-up signatures, extension form fill. Missing: `cv/master.json` `name`.                                                                                                                                                                                                                                                                    | `"Jane Doe"`                                                                         |
| `email`                 | email, `""` or null                        | Signatures. Missing: the CV's email.                                                                                                                                                                                                                                                                                                                       | `"jane.doe@example.com"`                                                             |
| `phone`                 | string or null                             | Signatures. Missing: the CV's phone.                                                                                                                                                                                                                                                                                                                       | `"+351 900 000 000"`                                                                 |
| `linkedin`              | URL, `""` or null                          | Signatures. Missing: the CV's LinkedIn.                                                                                                                                                                                                                                                                                                                    | `"https://www.linkedin.com/in/jane-doe/"`                                            |
| `city`, `country`       | string or null                             | Where you live: letters, AI prompts ("the candidate is based in ..."), the default remote-from country.                                                                                                                                                                                                                                                    | `"Lisbon"`, `"Portugal"`                                                             |
| `countryCode`           | two capital letters or null                | Where you live (ISO 3166-1 alpha-2). A target country with this code never needs a visa; Himalayas default country.                                                                                                                                                                                                                                        | `"PT"`                                                                               |
| `utcOffset`             | `GMT±H[:MM]` / `UTC±H[:MM]` or null        | Remote letters and prompts; Himalayas time-zone limits.                                                                                                                                                                                                                                                                                                    | `"GMT+0"`                                                                            |
| `currentLocation`       | text or null                               | Form answers; the extension's location field.                                                                                                                                                                                                                                                                                                              | `"Lisbon, Portugal"`                                                                 |
| `languages`             | text or null                               | AI screening and the language filter (split on `,` `/` `;` `and` `&`).                                                                                                                                                                                                                                                                                     | `"English, Portuguese"`                                                              |
| `workAuthorization`     | text or null                               | Form answers and prompts.                                                                                                                                                                                                                                                                                                                                  | `"Portuguese citizen: may work anywhere in the EU without a visa."`                  |
| `needsVisaSponsorship`  | text, boolean or null                      | Form answers.                                                                                                                                                                                                                                                                                                                                              | `"Only for onsite roles outside the EU."`                                            |
| `willingToRelocate`     | text, boolean or null                      | Form answers; "Yes..." (or `true`) adds relocation to letters.                                                                                                                                                                                                                                                                                             | `"Yes"`                                                                              |
| `nationality`           | text or null                               | Form answers.                                                                                                                                                                                                                                                                                                                                              | `"Portuguese"`                                                                       |
| `noticePeriod`          | text or null                               | Form answers.                                                                                                                                                                                                                                                                                                                                              | `"1 month"`                                                                          |
| `earliestStartDate`     | text or null                               | Form answers.                                                                                                                                                                                                                                                                                                                                              | `"Two weeks after an offer"`                                                         |
| `currentSalary`         | text, number or null                       | Form answers (leave null if you would rather not say).                                                                                                                                                                                                                                                                                                     | `null`                                                                               |
| `expectedSalary`        | object: country key → text, number or null | Form answers, and the dashboard's "below your expectation" hint (a hint only, never a filter). Keys are your `countries` codes plus `"remote"`. A plain number is read in the local currency for `AE` (AED, per month), `SA` (SAR, per month), `NL` (EUR, per year) and `remote` (USD, per year); for any other key write the currency and period as text. | `{ "NL": 70000, "AE": "AED 25,000 per month", "remote": "USD 60k per year" }`        |
| `workingHoursForRemote` | text or null                               | Form answers.                                                                                                                                                                                                                                                                                                                                              | `"Any overlap with CET"`                                                             |
| `howDidYouHear`         | text or null                               | Form answers.                                                                                                                                                                                                                                                                                                                                              | `"LinkedIn"`                                                                         |
| `coverLetter`           | object                                     | Sentences of the **template** letter, used when the AI is off or fails. Missing ones are left out.                                                                                                                                                                                                                                                         |                                                                                      |
| `coverLetter.intro`     | text or null                               | Opening sentence.                                                                                                                                                                                                                                                                                                                                          | `"I am a Full Stack Engineer with 5 years of experience building web applications."` |
| `coverLetter.pitch`     | object: CV cluster → text                  | One pitch per CV cluster (`laravel`, `mern`, `next-nest`, ...), plus `default`.                                                                                                                                                                                                                                                                            | `{ "default": "Most recently I built ..." }`                                         |
| `coverLetter.strengths` | text or null                               | Follows "Your posting asks for X, which is the core of my day-to-day work."                                                                                                                                                                                                                                                                                |                                                                                      |
| `coverLetter.remote`    | text or null                               | Follows "I am based in <location> (<UTC offset>)," in remote letters.                                                                                                                                                                                                                                                                                      | `"have worked remotely with distributed teams across Europe"`                        |
| `other`                 | object: question → fact                    | Anything else forms ask (e.g. `"Driving licence": "Yes, EU B"`).                                                                                                                                                                                                                                                                                           | `{}`                                                                                 |

The dashboard shows a banner until your profile has a **name, email, location, country code and languages** (name, email and location may come from `cv/master.json`).

## 7. Configuration reference: `config.json`

`config.json` is validated on every start (`src/settings.ts`), so a typo stops the bot with the file and field name. Check it without starting anything:

```bash
npm run bot -- settings:check --kind config --file config.json      # {"ok":true}
npm run bot -- settings:check --kind applicant --file cv/applicant.json
```

The dashboard's Settings page edits most keys (not `countries`, `companies`, `chromePath`, `cvFileName`, `adzuna`, `ai.concurrency`, `ai.claudePath`, the API response format or the older provider sections; edit those in the file). **After changing filters, run `npm run bot -- rescore`**: it re-applies the filters and keyword score to every stored job without downloading anything.

Defaults below are the values in the repository's `config.json` (the original author's), not values the code fills in, unless the table says "missing =".

### How filtering and scoring work

Every posting goes through `scoreJob()` in `src/match.ts`, in this order. The first rule that fails stores the job with status `filtered` and the reason (see it in the dashboard's **Filtered out** tab, or `npm run bot -- list --status filtered`).

1. **Remote or onsite.** A location containing `remote`, `anywhere`, `worldwide` or `work from home` is a remote job (if `remote.enabled`). Its region text is checked: a target country's `match` there makes it an onsite job in that country ("Remote — Dubai"); otherwise it must match `remote.allow`, and is filtered when it does not (with a different reason if it matches `remote.deny`). A description with strong "US-based only", "must reside in the EU" style phrases is filtered too. An empty region, or one matching `remote.flag`, passes with a "confirm your country is OK" flag.
2. **Country.** Otherwise the location must match one target country's `match` regex (for remote/EMEA-style locations, also "based in / office in <country>" in the description), or the job is filtered as "location not in target countries".
3. **Title.** The title must match `roleInclude` and must not match `roleExclude`. Both are case-insensitive regular expressions tested against the **title only**.
4. **Age.** Postings older than `maxAgeDays` are filtered (re-checked on every fetch and rescore, so matching jobs drop out as they age). Unknown dates pass with a flag.
5. **Language.** "Fluent / native / required" Dutch, Arabic, German or French is filtered unless your profile lists that language; "Dutch or Arabic is a plus" only adds a flag.
6. **Visa** (onsite in a country where you need one). "No sponsorship", "must have the right to work", "nationals only" and similar phrases are filtered. For `ind-register` countries the company must be on the IND register (run `sponsors:update`) or the posting must offer visa or relocation support, otherwise it is filtered. Remote jobs and countries with `needsVisa: false` skip this step.
7. **Keyword score.** The bot looks for about 40 known skills (`SKILL_PATTERNS` in `src/match.ts`: PHP, Laravel, Node.js, React, Python, Java, Go, AWS, Docker, ...) in the title and description. Each found skill counts as yours when your `cv/master.json` skills list it. The score is `matched weight / found weight × 100` (core skills weigh 2), capped at 50 when fewer than 3 skills match, minus 15 if the posting asks for more than 10 years, plus 5 for a senior / lead / staff title, minus 20 for a junior / entry title, clamped to 0–100. A posting with none of the known skills is filtered ("no recognisable tech stack"). Below `minScore` it is filtered.
8. **AI review** (later, `ai:score`): a 0–100 score, a verdict, reasons and a location check that reads the whole description. A location `no` moves a job to `filtered`. The dashboard's "best match first" sorts by the AI score, then the keyword score.

The skill list and the CV clusters are aimed at web stacks (PHP and JavaScript first). If your stack is not in `SKILL_PATTERNS`, the keyword score sees fewer of your skills: lean on the AI score, and keep `minScore` low.

### Countries and visa

| Key                          | Type                         | Default          | What it does                                                                                                                                                                                                     | Sensible value / when to change                                                                                                                               |
| ---------------------------- | ---------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `countries`                  | object: code → country       | `AE`, `SA`, `NL` | Target countries for **onsite** jobs. The key is the code stored on each job and used by the country filter, `list --country` and `expectedSalary`. Use the ISO code; never use `RM` (reserved for remote jobs). | Your targets. The wizard edits this.                                                                                                                          |
| `countries.<code>.name`      | text                         |                  | Full name, used in visa notes and prompts.                                                                                                                                                                       | `"Netherlands"`                                                                                                                                               |
| `countries.<code>.match`     | regex                        |                  | Location text that means this country (case-insensitive).                                                                                                                                                        | Country names, common cities, `\b`-bounded abbreviations: `dubai\|abu dhabi\|\buae\b\|united arab emirates`. Avoid short bare words that occur inside others. |
| `countries.<code>.visa`      | `employer` \| `ind-register` |                  | Who arranges the work permit. `ind-register`: the company must be an IND recognised sponsor (Netherlands only; run `sponsors:update` first, or every NL job that does not mention visa support is filtered).     | `employer` everywhere except NL.                                                                                                                              |
| `countries.<code>.needsVisa` | boolean                      | missing = `true` | `false` skips the sponsorship rules (you may already work there). Your own `countryCode` never needs one.                                                                                                        | `false` for countries where you hold a right to work.                                                                                                         |
| `countries.<code>.label`     | text                         | missing = `name` | Short name on the dashboard.                                                                                                                                                                                     | `"Saudi"`                                                                                                                                                     |

### Remote

| Key                       | Type                | Default                                                       | What it does                                                                                                                                                                                                     | Sensible value / when to change                                                   |
| ------------------------- | ------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `remote.enabled`          | boolean             | `true`                                                        | Turns on remote jobs: the remote boards, LinkedIn's remote search and remote matching in the filter.                                                                                                             | `false` if you only want onsite jobs.                                             |
| `remote.boards`           | list                | `himalayas`, `remotive`, `remoteok`, `arbeitnow`, `adzuna`    | Which job boards to fetch. Names not in that list are ignored silently. `arbeitnow` keeps only remote postings and those matching your `NL` country (mostly a German board); `adzuna` needs the `ADZUNA_*` keys. | Drop boards that bring only noise for you.                                        |
| `remote.himalayasQueries` | list                | `laravel`, `php`, `node`, ...                                 | Himalayas search terms, up to 10 pages each.                                                                                                                                                                     | 5–10 terms for your stack.                                                        |
| `remote.allow`            | regex               | `worldwide\|anywhere\|global\|pakistan\|...`                  | Remote regions that **include** you. A remote job's region must match this.                                                                                                                                      | Worldwide words, your country, your continent / time zone (`emea`, `gmt ?\+ ?1`). |
| `remote.deny`             | regex               | `\b(us\|usa)\b\|united states\|...`                           | Regions that exclude you; only changes the filter reason when `allow` does not match.                                                                                                                            | Big regions you are outside of. Must **not** match your own country.              |
| `remote.flag`             | regex               | `emea\|international\|not stated`                             | Regions that pass but get a "confirm your country is OK" flag.                                                                                                                                                   | Vague regions.                                                                    |
| `remote.from`             | text                | missing = `linkedin.remoteFrom`, then the profile's `country` | The country you work remotely from: filter reasons, visa notes, AI prompts.                                                                                                                                      | Your country.                                                                     |
| `remote.fromCode`         | two capital letters | missing = the profile's `countryCode`                         | Himalayas `country=` filter: only jobs open to this country.                                                                                                                                                     | Your ISO code.                                                                    |

### LinkedIn

LinkedIn is searched as a guest (no login, your account is never used), with requests 1.2 s apart. The number of list requests is (`locations` + 1 remote search) × `keywords` × `pagesPerSearch`, plus one request per new posting for its description. A 429 answer stops LinkedIn for the rest of the run, keeping what was fetched.

| Key                       | Type    | Default                                               | What it does                                                                                | Sensible value / when to change                           |
| ------------------------- | ------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `linkedin.enabled`        | boolean | `true`                                                | Include LinkedIn in `fetch`.                                                                | `false` while you are rate-limited.                       |
| `linkedin.keywords`       | list    | `laravel`, `php`, `node.js`, ...                      | One search per keyword per location. Also Adzuna's default keywords.                        | 4–8 keywords: your main frameworks and role names.        |
| `linkedin.locations`      | list    | `United Arab Emirates`, `Saudi Arabia`, `Netherlands` | Onsite search locations, as typed in LinkedIn's location box.                               | Your target countries (or cities).                        |
| `linkedin.remoteFrom`     | text    | `Pakistan`                                            | Location of the remote (`f_WT=2`) search; empty = no remote search. Needs `remote.enabled`. | Your country. The wizard sets it.                         |
| `linkedin.pagesPerSearch` | count   | `2`                                                   | 10 results per page.                                                                        | 1–3. More pages mean more requests and a higher 429 risk. |

### Company boards and ATS

| Key                   | Type                                                                                              | Default                           | What it does                                                                                                                                                                                                | Sensible value / when to change                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `companies`           | list                                                                                              | 50 UAE, Saudi and Dutch companies | Company career boards fetched through their public ATS APIs.                                                                                                                                                | Replace with companies you would work for. `npm run bot -- discover <name...> --add` finds a company's board and adds it when it has jobs in your target countries. |
| `companies[].name`    | text                                                                                              |                                   | Display name (and `fetch --company <name>` matches it).                                                                                                                                                     |                                                                                                                                                                     |
| `companies[].ats`     | `greenhouse` \| `lever` \| `ashby` \| `recruitee` \| `workable` \| `smartrecruiters` \| `workday` |                                   | Which platform.                                                                                                                                                                                             |                                                                                                                                                                     |
| `companies[].token`   | text                                                                                              |                                   | The board's id on that platform, e.g. `careem` for `boards.greenhouse.io/careem`. Workday: `<tenant>/<wdN>/<site>`, e.g. `acme/wd3/AcmeCareers` for `https://acme.wd3.myworkdayjobs.com/en-US/AcmeCareers`. |                                                                                                                                                                     |
| `companies[].indName` | text, optional                                                                                    |                                   | The company's legal name on the Dutch IND register when it differs from `name`.                                                                                                                             | Only for `ind-register` countries.                                                                                                                                  |

### Filters and scoring

| Key           | Type   | Default                                 | What it does                                                                                                                                              | Sensible value / when to change                                                                                                                            |
| ------------- | ------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minScore`    | number | `45`                                    | Minimum keyword score (0–100) for a job to stay `new`.                                                                                                    | 30–60. Above 50, jobs where fewer than 3 of your skills appear are always filtered. Lower it if good jobs show up in **Filtered out** as "below minScore". |
| `maxAgeDays`  | count  | `14`                                    | Postings older than this are filtered and expire from the list. Also the LinkedIn, Himalayas, Arbeitnow and Adzuna search window.                         | 7–30.                                                                                                                                                      |
| `roleInclude` | regex  | `engineer\|developer\|full.?stack\|...` | A title must match this.                                                                                                                                  | Words in titles you want.                                                                                                                                  |
| `roleExclude` | regex  | `data scien\|...\|python\|...`          | A title matching this is filtered. The repository's list excludes other stacks (Java, Go, Python, ...), mobile, QA, DevOps, management, interns and more. | **Rewrite it for your stack**, e.g. remove `python` if you are a Python developer.                                                                         |

Regex tips for `roleInclude` / `roleExclude` / `match` / `allow` / `deny`: they are JavaScript regular expressions, matched case-insensitively anywhere in the text. In JSON, a backslash is written twice: `"\\bqa\\b"` means `\bqa\b`. Use `\b` around short words (`\\bgo\\b`, `\\bjava\\b`, `\\bml\\b`) so `go` does not match "Google" and `java` does not match "JavaScript"; `.?` covers optional characters (`full.?stack` matches "fullstack", "full-stack", "full stack"). Test a pattern quickly with `node -e 'console.log(/full.?stack/i.test("Senior Full-Stack Engineer"))'`.

### Adzuna (optional section)

| Key                     | Type             | Default                                        | What it does                                                                                              | Sensible value / when to change       |
| ----------------------- | ---------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `adzuna`                | object, optional | `{ "countries": ["nl"], "pagesPerSearch": 2 }` | Settings for the `adzuna` board. Missing = the defaults in the next rows.                                 |                                       |
| `adzuna.countries`      | list             | missing section = `["nl"]`                     | Adzuna country indexes (lower-case: `gb`, `us`, `de`, `nl`, `fr`, ...). Adzuna has no UAE or Saudi index. | Indexes for your targets.             |
| `adzuna.keywords`       | list, optional   | missing = `linkedin.keywords`                  | Search terms.                                                                                             |                                       |
| `adzuna.pagesPerSearch` | count            | missing section = `2`                          | 50 results per page.                                                                                      | 1–3 (the free plan has tight limits). |

### AI provider and models

| Key                        | Type                                                                                                                           | Default                         | What it does                                                                                                                                                                                                                                                                 | Sensible value / when to change                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `ai.enabled`               | boolean                                                                                                                        | `true`                          | `false` makes letters and follow-ups use the templates, and turns off the CV summary, letter feedback and interview prep. It does **not** stop the fit review (`ai:score`, also run by the daily fetch) or form answers: those still call the provider and fail without one. | `false` only if you have no AI at all.                               |
| `ai.provider`              | `claude-cli` \| `api` (older: `openai`, `deepseek`)                                                                            | missing = `claude-cli`          | Who answers (section 8).                                                                                                                                                                                                                                                     |                                                                      |
| `ai.claudePath`            | text                                                                                                                           |                                 | The Claude Code CLI executable. Required even with `api` (kept for switching back).                                                                                                                                                                                          | `which claude`                                                       |
| `ai.scoreModel`            | text                                                                                                                           | `haiku`                         | Claude CLI model for the fit review.                                                                                                                                                                                                                                         | `haiku` (fast, cheap)                                                |
| `ai.letterModel`           | text                                                                                                                           | `sonnet`                        | Claude CLI model for letters, CV summaries, answers, interview prep and follow-ups.                                                                                                                                                                                          | `sonnet`                                                             |
| `ai.api.preset`            | `openai` \| `deepseek` \| `anthropic` \| `gemini` \| `groq` \| `openrouter` \| `mistral` \| `together` \| `ollama` \| `custom` | missing = detected from the key | The API provider.                                                                                                                                                                                                                                                            | Set it for DeepSeek, Mistral, Together, Ollama and custom endpoints. |
| `ai.api.baseUrl`           | URL                                                                                                                            | missing = the preset's          | OpenAI-compatible base URL; `AI_BASE_URL` in `.env` wins.                                                                                                                                                                                                                    | Only for a proxy or custom endpoint.                                 |
| `ai.api.scoreModel`        | text                                                                                                                           | missing = the preset's          | API model for the fit review.                                                                                                                                                                                                                                                |                                                                      |
| `ai.api.letterModel`       | text                                                                                                                           | missing = the preset's          | API model for writing.                                                                                                                                                                                                                                                       |                                                                      |
| `ai.api.responseFormat`    | `json_schema` \| `json_object` \| `text`                                                                                       | missing = the preset's          | How JSON is asked for.                                                                                                                                                                                                                                                       | Only if a provider rejects the default.                              |
| `ai.openai`, `ai.deepseek` | `{ scoreModel, letterModel, baseUrl }`, optional                                                                               |                                 | Older provider sections, still read for `provider: "openai"` / `"deepseek"`. The wizard moves their models into `ai.api`.                                                                                                                                                    |                                                                      |
| `ai.maxScorePerRun`        | count                                                                                                                          | `80`                            | Most jobs one `ai:score` run reviews (best keyword score first). `--limit` overrides it.                                                                                                                                                                                     | 30–100: caps time and cost per day.                                  |
| `ai.concurrency`           | positive integer                                                                                                               | `2`                             | AI reviews in parallel.                                                                                                                                                                                                                                                      | 1–4. Higher is faster but hits rate limits sooner.                   |
| `ai.alertStrong`           | boolean, optional                                                                                                              | missing = `true`                | macOS notification when a job gets the `strong` verdict (once per job; grouped above three).                                                                                                                                                                                 | `false` to stay quiet.                                               |

### CV output

| Key              | Type    | Default           | What it does                                                                                                                                                                                | Sensible value / when to change                                         |
| ---------------- | ------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `chromePath`     | text    | `"auto"`          | Which Chrome prints CV and letter PDFs. `"auto"` (or missing): the newest Playwright headless shell, else an installed Google Chrome or Chromium (src/cv/chrome.ts). `JOB_BOT_CHROME` wins. | Keep `"auto"`; set a path only for a Chrome elsewhere.                  |
| `cvFileName`     | text    | the author's name | File name of every CV PDF (`cv/default/<cvFileName>`, `cv/versions/<id>/<cvFileName>`); recruiters see it.                                                                                  | `jane_doe_resume.pdf`                                                   |
| `autoCvVersions` | boolean | `false`           | `true`: `prepare` picks the per-stack CV version a job fits. `false`: always the default CV unless you pass `--cv`.                                                                         | Keep `false` until you have rewritten `src/cv/profiles.ts` for your CV. |

## 8. Choosing an AI provider

Every AI feature (fit review, cover letter, CV summary, form answers, interview prep, follow-ups) goes through one function, `askAi` in `src/ai-providers.ts`, and `ai.provider` picks who answers.

|        | `claude-cli` (default)                                                                                   | `api`                                                            |
| ------ | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| How    | Runs your signed-in Claude Code CLI (`claude -p`), headless: no tools, no MCP servers, no saved session. | `POST <base URL>/chat/completions` on any OpenAI-compatible API. |
| Key    | None.                                                                                                    | `AI_API_KEY` in `.env`.                                          |
| Cost   | Comes out of your Claude plan's usage.                                                                   | Paid per token to that provider.                                 |
| Models | `ai.scoreModel` / `ai.letterModel` (`haiku` / `sonnet`).                                                 | `ai.api.scoreModel` / `ai.api.letterModel`, else the preset's.   |

With `api`, the provider comes from `ai.api.preset`, else from `AI_BASE_URL` (a custom endpoint), else from the key's prefix:

| Preset                | Key prefix                                  | Score model (default)   | Letter model (default)    |
| --------------------- | ------------------------------------------- | ----------------------- | ------------------------- |
| `anthropic`           | `sk-ant-`                                   | `claude-haiku-5-5`      | `claude-sonnet-5-5`       |
| `openrouter`          | `sk-or-`                                    | `openai/gpt-4o-mini`    | `openai/gpt-4o`           |
| `groq`                | `gsk_`                                      | `llama-3.1-8b-instant`  | `llama-3.3-70b-versatile` |
| `gemini`              | `AIza`                                      | `gemini-2.5-flash`      | `gemini-2.5-pro`          |
| `openai`              | any other `sk-`                             | `gpt-4o-mini`           | `gpt-4o`                  |
| `deepseek`            | `sk-` too: **set the preset**               | `deepseek-chat`         | `deepseek-chat`           |
| `mistral`, `together` | set the preset                              | see `src/ai-presets.ts` |                           |
| `ollama`              | no key (local, `http://localhost:11434/v1`) | `llama3.1`              | `llama3.1`                |
| `custom`              | any                                         | `ai.api.scoreModel`     | `ai.api.letterModel`      |

Example, Anthropic API:

```jsonc
// config.json
"ai": { "enabled": true, "provider": "api", "claudePath": "claude", "scoreModel": "haiku", "letterModel": "sonnet",
        "maxScorePerRun": 80, "concurrency": 2 }
```

```bash
# .env
AI_API_KEY=sk-ant-...
```

What to expect:

- **Speed:** a fit review takes about 10 s and a letter 15–60 s with any provider.
- **Cost:** each fit review sends your whole `cv/master.json` and one job description, so a few thousand input tokens; a letter or summary is similar plus a few hundred output tokens. Most of the volume is the fit review: up to `ai.maxScorePerRun` jobs a day with the small score model. Check your provider's pricing and usage page after the first day. With `claude-cli`, the same runs use your plan's usage limits instead.
- **Safety of the key:** it is read only from the environment, never written to `config.json`, never logged, and only sent to the provider's base URL. The dashboard only shows whether `AI_API_KEY` is set and which provider it looks like.
- **Errors:** a missing key stops before any request; a rejected key (401/403) stops at once and names `AI_API_KEY`; a reply that is not the JSON asked for is retried once.
- **Ollama / small models** cost nothing but follow the JSON schema less reliably; failed reviews are reported and can be retried.

Switch any time on the Settings page or with the wizard.

## 9. First run

```bash
npm run bot -- settings:check --kind config --file config.json   # {"ok":true}
npm run bot -- cv:default          # renders your CV PDF (checks Chrome and cv/master.json)
npm run bot -- sponsors:update     # only if a target country uses "ind-register" (Netherlands); monthly is enough
npm run bot -- fetch               # all sources, 4 at a time; a few minutes. Applies the migrations first
npm run bot -- ai:score            # AI review of new matches (up to ai.maxScorePerRun)
npm run web                        # dashboard on http://localhost:3100
```

`fetch` prints one line per source (`✓ Careem: 12 postings`, `✗ ... error`) and a summary. Useful next commands:

```bash
npm run bot -- stats                       # job counts per status and country
npm run bot -- list                        # best new matches
npm run bot -- list --status filtered      # what was filtered and why
npm run bot -- fetch --company linkedin    # one source only (matches company or board names)
```

On the dashboard: open a job, **Prepare CV**, **Write letter**, check the CV keyword check, then apply on the company's site yourself and mark the job **Applied**. Leave the terminal with `npm run web` open; the dashboard stops when you close it.

The dashboard listens only on `127.0.0.1:3100` and refuses requests whose Host is not localhost. It has no login, so never expose it.

## 10. The daily fetch (launchd)

`scripts/daily-fetch.sh` runs `fetch`, then `check:open --limit 100` (closed postings become `expired`), then `ai:score`, shows a notification, and backs up the database to `data/backups/` (newest 14 kept). It logs to `data/fetch.log`.

Save this as `~/Library/LaunchAgents/com.<you>.job-bot.fetch.plist`, replacing `<you>` with your macOS user name and the path with your clone's:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.<you>.job-bot.fetch</string>
  <key>ProgramArguments</key><array><string>/Users/<you>/job-bot/scripts/daily-fetch.sh</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardErrorPath</key><string>/Users/<you>/job-bot/data/launchd.err</string>
</dict>
</plist>
```

Load it, run it once now, and check the log:

```bash
mkdir -p ~/job-bot/data
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.<you>.job-bot.fetch.plist
launchctl kickstart gui/$(id -u)/com.<you>.job-bot.fetch
tail -f ~/job-bot/data/fetch.log
```

Turn it off with `launchctl bootout gui/$(id -u)/com.<you>.job-bot.fetch`.

Notes:

- **PATH:** the script sets `PATH` to `~/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`. `node` (and `claude`, `pg_dump` for the backup) must be in one of those folders. A Node installed only through nvm or fnm is not found: install Node with Homebrew too, or symlink it into `/usr/local/bin`.
- **Sleep:** if the Mac is asleep at 9:00, launchd runs the job when it wakes. If it is **shut down** at 9:00, the run is skipped (see Troubleshooting).
- Only one fetch runs at a time: if the dashboard's **Fetch new jobs** is running, the script's fetch is skipped.

## 11. The Chrome extension

The extension (`extension/`) sends the job you are looking at to job-bot and shows the prepared CV, letter and answers in a side panel. **Fill this form** types them into the form's empty fields; it never overwrites a field, never clicks a button and never submits.

1. Start the dashboard (`npm run web`).
2. Open `chrome://extensions` and turn on **Developer mode**.
3. **Load unpacked** and choose the `extension/` folder of your clone.
4. Pin the job-bot button to the toolbar.

It talks only to `http://localhost:3100`. Details, permissions and the pinned extension id: [extension/README.md](../extension/README.md).

The older Bayt bookmarklet still works: it is under "Add jobs from Bayt" on the dashboard's home page.

## 12. Updating

```bash
cd ~/job-bot
git pull
npm install && npm --prefix web install   # when package.json or the lockfiles changed
npm run bot -- stats                      # any database command applies new migrations
```

Then restart the dashboard (stop `npm run web` with Ctrl+C and start it again) and press the reload icon on the extension's card in `chrome://extensions`.

Migrations (`src/migrations/NNN_name.sql`) are applied automatically by the **bot** on its next database command and recorded in `schema_migrations`. The dashboard does not apply them itself, so after a pull run one bot command (as above, or let the next fetch do it) before using the dashboard.

If you replaced `config.json` or `cv/master.json` with your own, `git pull` may conflict on them: they are tracked files holding the original author's data. Keep your versions (for example `git checkout --ours config.json cv/master.json` during the merge), or work on a branch of your own and merge `main` into it.

## 13. Troubleshooting

**The dashboard does not load (http://localhost:3100).** It only runs while `npm run web` is running, and nothing starts it after a reboot: start it again. It binds to `127.0.0.1`, so use `http://localhost:3100` or `http://127.0.0.1:3100` on the same Mac; it is not reachable from your phone or another computer, and another Host header gets "job-bot only answers on localhost". If the page shows a database error, check that Postgres is running and `web/.env.local` has `DATABASE_URL`. A "column does not exist" error after an update means the migrations have not run yet: run `npm run bot -- stats`.

**The 9:00 fetch did not run.** launchd catches up a missed run when the Mac wakes from sleep, but not when it was shut down. Run it by hand: `launchctl kickstart gui/$(id -u)/com.<you>.job-bot.fetch`, or **Fetch new jobs** on the dashboard, or `npm run bot -- fetch && npm run bot -- ai:score`. To also run it at every login, add `<key>RunAtLoad</key><true/>` to the plist and bootstrap it again (bootout first). Check `data/fetch.log`: "Fetch failed — is PostgreSQL (DBngin) running?" means the database was down, and nothing in the log at all usually means the folder is under `~/Desktop` or `~/Documents`, or `node` was not on the script's PATH (see `data/launchd.err`).

**LinkedIn returns 429.** LinkedIn throttles guest searches from your IP. The bot stops LinkedIn for that run and keeps what it had; the other sources are unaffected. It usually clears within a day. Make fewer requests: fewer `linkedin.keywords` or `locations`, `pagesPerSearch: 1`, or `linkedin.enabled: false` for a few days.

**"AI review failed (is Claude signed in?)".** The Claude Code CLI is signed out or not at `ai.claudePath`. Run `claude` in a terminal and sign in (`/login`), check `which claude` against `config.json` `ai.claudePath`, then `npm run bot -- ai:score`. Fetching is not affected: the daily script only skips the review.

**No Chrome found, or the wrong one (`cv:default`, Prepare CV or Download PDF fails to launch a browser).** Run `npx playwright-core install chromium-headless-shell` and keep `chromePath: "auto"`. A Chrome icon flashing in the Dock for every PDF means the full Chrome app is used: install the headless shell. To use a specific Chrome, set `chromePath` (or `JOB_BOT_CHROME`) to the executable itself, not the `.app` folder.

**No jobs match.** Look at the reasons first: `npm run bot -- list --status filtered` or the **Filtered out** tab.

- "location not in target countries": widen `countries.<code>.match` (cities, spellings), or the jobs are elsewhere.
- "title is not an engineering role" / "title excluded": your titles are not in `roleInclude`, or `roleExclude` catches them (the repository's list excludes Python, Java, Go, mobile, DevOps, QA, management and more).
- "remote, region does not include ...": add your region to `remote.allow`.
- "score N below minScore": lower `minScore`, or add the skills you have to `cv/master.json`.
- "NL job but company not on IND sponsor register": run `npm run bot -- sponsors:update`.
- "no recognisable tech stack": your stack is not in the keyword list in `src/match.ts`.

Then `npm run bot -- rescore` (no downloads). Also check that `companies`, `linkedin.keywords` and `remote.himalayasQueries` are about your stack and markets, not the author's.

**The "Welcome! Set up your profile first." / "Your profile is incomplete." banner.** `cv/applicant.json` is missing, or the profile lacks a name, email, location, country code or languages. Run `npm run bot -- setup` or open **Settings** on the dashboard. Name, email and location may also come from `cv/master.json`.

**"Invalid settings file ...".** The message names each bad field with its path, e.g. `companies[3].ats`. Fix it, then `npm run bot -- settings:check --kind config --file config.json`.

**Tests fail after you replaced `config.json` or `cv/master.json`.** Some tests pin the original author's letters and filter results (`tests/fixtures/owner-golden.json`) against the repository's `config.json` and `cv/master.json`. That is expected with your own files; the tests are for developing the bot.

## 14. Privacy: what stays on your Mac

Everything runs locally: the database, the dashboard (127.0.0.1 only) and the CLI. What leaves your Mac:

- requests to job boards and ATS APIs (no personal data; LinkedIn is used as a guest);
- the AI prompts, which contain your CV, profile and the job description: to Anthropic through the Claude CLI, or to the API provider you chose (nothing with a local Ollama);
- the IND register download, if you use it.

Gitignored, never committed: `.env`, `web/.env.local`, `cv/applicant.json`, `cv/versions/` (generated CVs), `applications/` (letters per job), `data/` (logs, HTTP cache, IND register, backups).

**Tracked by git:** `config.json`, `cv/master.json`, `cv/default/` and `cv/original/`. In the original repository they hold the author's data, which is why it is private. If you commit your own CV there, keep your copy of the repository private too.
