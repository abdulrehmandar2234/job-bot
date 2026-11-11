# Talaash documentation: start here

Talaash is a job-search assistant that runs on your own computer. It finds software jobs in the countries you target (onsite, with or without a visa) and remote jobs open to where you live, filters and scores them against your CV, and prepares a CV version, cover letter and form answers for each one.
It **never applies on your behalf**: you review everything and submit every application yourself.
It is a Node.js command-line bot plus a local web dashboard, sharing one PostgreSQL database on your machine.

**In a hurry?** The [Quickstart](quickstart.md) is the short path: six commands from a clone to your first jobs. **Have Docker?** [Run Talaash with Docker](install/docker.md): one command starts the database, the dashboard and the daily run.

## 1. Install it on your computer

Pick your operating system. Each guide is complete on its own, from a fresh machine to a working dashboard, with commands for that system only.

| Your computer                                   | Guide                                    | Terminal to use     |
| ----------------------------------------------- | ---------------------------------------- | ------------------- |
| macOS (Apple silicon or Intel)                  | [install/macos.md](install/macos.md)     | Terminal (zsh)      |
| Linux (Ubuntu / Debian; notes for Fedora, Arch) | [install/linux.md](install/linux.md)     | any terminal (bash) |
| Windows 10 or 11                                | [install/windows.md](install/windows.md) | PowerShell          |

Every guide assumes Git is installed and covers the same steps: Node.js 24+ and PostgreSQL; the database; the code and its env files; the PDF renderer; the AI; the setup wizard; your CV; the first fetch and the dashboard; the daily run; notifications; the Chrome extension; and a final checklist.

## 2. Make it yours

| Page                                             | What is in it                                                                                                                                            |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [your-cv-and-profile.md](your-cv-and-profile.md) | `cv/master.json` (your CV as data) and `cv/applicant.json` (your profile), field by field; CV templates and versions; letters, CV summaries and feedback |
| [configuration.md](configuration.md)             | Every key of `config.json`, every environment variable, and how filtering and scoring decide which jobs you see                                          |
| [ai.md](ai.md)                                   | The Claude Code CLI or one API key, presets and key prefixes, models, cost, and running without AI                                                       |

## 3. Use it

| Page                                     | What is in it                                                                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [daily-use.md](daily-use.md)             | The dashboard (tabs, search, filters, Prepare CV, letters, answers, the extension's auto-fill, follow-ups) and the CLI commands you use day to day |
| [troubleshooting.md](troubleshooting.md) | Common problems, general and per OS                                                                                                                |
| [updating.md](updating.md)               | Getting a newer version: pull, install, migrations, extension reload, dashboard restart                                                            |

## 4. Look it up

| Page                               | What is in it                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [features.md](features.md)         | Everything Talaash does, and every job source it reads                                                       |
| [cli.md](cli.md)                   | Every command, and the daily run                                                                             |
| [how-it-works.md](how-it-works.md) | The architecture, the path of one job, the CV pipeline, the database, the code layout, the tech stack, tests |

Want to improve Talaash? See [CONTRIBUTING.md](https://github.com/abdulrehmandar2234/talaash/blob/main/CONTRIBUTING.md). The Chrome extension has its own [README](https://github.com/abdulrehmandar2234/talaash/blob/main/extension/README.md).

## About the repository's own data

The repository is a working copy of one person's setup. These tracked files hold **the original owner's** data, and you replace them with your own:

- `config.default.json`: the default settings, which are the owner's search settings with nothing personal in them: target markets (the UAE, Saudi Arabia, the Netherlands, Pakistan, remote from Pakistan), about 55 company boards, job-title rules and search keywords for a Laravel / PHP / Node / React developer. Your own `config.json` starts as a copy of it on the first run and is never committed.
- `presets/`: ready-made markets (`gulf`, `india`, `netherlands`, `pakistan`) and stacks (`php-laravel`, `javascript`, `python`). `npm run bot -- setup` offers them, then asks for the markets, AI and CV file name; the rest you review yourself (see [configuration.md](configuration.md#presets)).
- `cv/master.json`: your CV, gitignored (a fresh clone has none). Start from `cv/master.example.json`; `setup` offers to copy it.
- `src/cv/profiles.ts`: per-stack CV headlines and summaries written for the owner's CV (see [your-cv-and-profile.md](your-cv-and-profile.md#cv-versions-and-the-per-stack-framings)).

Wherever these docs show the owner's values, they are labelled as examples.

## Privacy: what stays on your computer

Everything runs locally: the database, the dashboard (it only answers on `127.0.0.1`) and the CLI. What leaves your computer:

- requests to job boards and ATS APIs (no personal data; LinkedIn is searched as a guest, your account is never used);
- the AI prompts, which contain your CV, profile and the job description: to Anthropic through the Claude CLI, or to the API provider you chose (nothing leaves with a local Ollama);
- the Dutch IND sponsor register download, if you use it.

Gitignored, never committed: `config.json`, `.env`, `web/.env.local`, `cv/applicant.json`, `cv/versions/` (generated CVs), `applications/` (letters per job) and `data/` (logs, HTTP cache, IND register, backups).

Your CV (`cv/master.json`, `cv/default/`, `cv/original/`) is gitignored too. **Tracked by git:** `config.default.json`, `presets/`, the example files `cv/master.example.json` and `cv/applicant.example.json`, and `src/cv/profiles.ts` (the owner's per-stack framings).
