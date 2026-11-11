# Talaash

_Talaash_ (Urdu for "search") is a personal job-search assistant that runs on your own computer (macOS, Linux or Windows). It finds software engineering jobs in the **countries you target** (onsite, with or without a visa) and **remote jobs open to the country you live in**, filters and scores them against your CV, prepares the right CV version, cover letter and form answers for each one, and tracks where you applied.

**It never applies on your behalf.** The bot finds, scores and prepares; you review everything and submit every application yourself.

**Documentation:** [abdulrehmandar2234.github.io/talaash](https://abdulrehmandar2234.github.io/talaash/) (the same pages are in [docs/](docs/README.md)).

## Quick start

You need Git, Node.js 24+ and PostgreSQL 15+ running, and for the AI a signed-in [Claude Code CLI](docs/ai.md) or one API key of any OpenAI-compatible provider.

```bash
git clone https://github.com/abdulrehmandar2234/talaash.git && cd talaash
npm install && npm --prefix web install
npx playwright-core install chromium-headless-shell   # prints CVs and letters to PDF
npm run bot -- setup     # writes .env, creates the database, starts your CV, asks for your profile and markets
npm run bot -- doctor    # checks the whole setup and says how to fix what is missing
```

Then put your own CV in `cv/master.json` (it starts as the fictional Jane Doe), and:

```bash
npm run bot -- cv:default   # your CV as a PDF
npm run bot -- fetch        # the first jobs, a few minutes
npm run web                 # the dashboard on http://localhost:3100
```

The [Quickstart](docs/quickstart.md) explains each step. For a fresh machine, follow the full guide for your computer: [macOS](docs/install/macos.md), [Linux](docs/install/linux.md) or [Windows](docs/install/windows.md).

## What it does

- **Finds jobs** every morning from company career boards (Greenhouse, Lever, Ashby, Recruitee, Workable, SmartRecruiters, Workday, Personio), job boards (Himalayas, Remotive, RemoteOK, Jobicy, Arbeitnow, Adzuna, Hacker News "Who is hiring"), LinkedIn's guest search, and any job page through the Chrome extension.
- **Filters** by country, visa, remote region, job title, language and posting age, and keeps every rejected job with the reason, so you can see why.
- **Scores** each match: a keyword score against your CV, then an AI review (0–100, verdict, reasons, gaps, red flags) that also reads the whole description for location limits.
- **Prepares** a CV version and template, a cover letter, a CV headline and summary for the job, form answers and interview prep, using only facts from your CV.
- **Helps you apply:** the Chrome extension types the prepared values into empty form fields when you click **Fill this form**. It never overwrites what you typed, never clicks a button and never submits.
- **Tracks** every application: statuses, notes, contacts, follow-up reminders, dead-link checks and analytics.

Every feature and every source is described in [Features](docs/features.md).

## How it works

Two programs share one local PostgreSQL database:

1. **The bot CLI** (`src/`, Node + TypeScript): fetches, scores, calls the AI and renders CV PDFs. `npm run bot -- <command>`; every command is in the [CLI reference](docs/cli.md).
2. **The dashboard** (`web/`, Next.js, `npm run web`): your job list, job pages, settings and analytics. Heavy work runs as background tasks through the same CLI commands.

A scheduler runs `bot daily` once a day at a time you choose, 09:00 by default (fetch, dead-link check, AI review, notification, backup, cleanup). The architecture, the path of one job and the code layout are in [How it works](docs/how-it-works.md).

## Principles

- **Local first.** The database, the dashboard and the CLI run on your machine; the dashboard only answers on `127.0.0.1`. The AI is the Claude Code CLI you are signed in to, or one API key of your own ([AI](docs/ai.md)).
- **APIs over scraping.** Public job-board APIs wherever possible, with paced requests. No logins, account creation or CAPTCHAs are ever automated.
- **Truthful CVs.** CV versions only re-order and re-frame what is in your master CV; they never add skills or claims (enforced by tests).
- **Nothing personal in the code.** Your CV, profile and settings (`cv/master.json`, `cv/applicant.json`, `config.json`, `.env`) are gitignored and stay on your computer.

## Documentation

| Page                                                                                                          | What is in it                                                          |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [Quickstart](docs/quickstart.md)                                                                              | Six commands from a clone to your first jobs                           |
| Install on [macOS](docs/install/macos.md), [Linux](docs/install/linux.md), [Windows](docs/install/windows.md) | From a fresh machine to the daily run and the extension                |
| [Your CV and profile](docs/your-cv-and-profile.md)                                                            | `cv/master.json`, `cv/applicant.json`, templates, letters, CV feedback |
| [Configuration](docs/configuration.md)                                                                        | Every `config.json` key and environment variable, presets, filters     |
| [AI](docs/ai.md)                                                                                              | Claude CLI or one API key, presets, models, cost, running without AI   |
| [Daily use](docs/daily-use.md)                                                                                | The dashboard, the extension, follow-ups, everyday commands            |
| [Features](docs/features.md)                                                                                  | Everything Talaash does, and every job source                          |
| [CLI reference](docs/cli.md)                                                                                  | Every command and the daily run                                        |
| [How it works](docs/how-it-works.md)                                                                          | Architecture, a job's journey, CV pipeline, database, tests            |
| [Troubleshooting](docs/troubleshooting.md)                                                                    | Common problems, general and per OS                                    |
| [Updating](docs/updating.md)                                                                                  | Getting a newer version                                                |

To browse them as a site on your computer: `npm --prefix docs install`, then `npm run docs` (http://localhost:3300).

## Contributing

Pull requests are welcome: fork the repository, change it on a branch and open a pull request. [CONTRIBUTING.md](CONTRIBUTING.md) has the ground rules (the bot never applies, CVs stay truthful, nothing personal in commits), the development setup and the checks to run. [ROADMAP.md](ROADMAP.md) lists what is done and what is still open.

## License

[MIT](LICENSE): you may use, copy, change and share the code, also commercially, as long as the copyright notice stays with it. It comes with no warranty.
