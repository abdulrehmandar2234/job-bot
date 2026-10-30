# job-bot documentation: start here

job-bot is a job-search assistant that runs on your own computer. It finds software jobs in the countries you target (onsite, with or without a visa) and remote jobs open to where you live, filters and scores them against your CV, and prepares a CV version, cover letter and form answers for each one.
It **never applies on your behalf**: you review everything and submit every application yourself.
It is a Node.js command-line bot plus a local web dashboard, sharing one PostgreSQL database on your machine.

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

Want to improve job-bot? See [CONTRIBUTING.md](../CONTRIBUTING.md). The project's [README](../README.md) has the full feature list, the architecture and the complete CLI reference. The Chrome extension has its own [README](../extension/README.md).

## About the repository's own data

The repository is a working copy of one person's setup. These tracked files hold **the original owner's** data, and you replace them with your own:

- `config.json`: the owner's target markets (the UAE, Saudi Arabia, the Netherlands, remote from Pakistan), about 50 company boards, job-title rules and search keywords for a Laravel / PHP / Node / React developer. `npm run bot -- setup` rewrites the markets, AI and CV file name; the rest you review yourself (see [configuration.md](configuration.md)).
- `cv/master.json`: the owner's CV. You replace it with yours, starting from `cv/master.example.json`.
- `src/cv/profiles.ts`: per-stack CV headlines and summaries written for the owner's CV (see [your-cv-and-profile.md](your-cv-and-profile.md#cv-versions-and-the-per-stack-framings)).

Wherever these docs show the owner's values, they are labelled as examples.

## Privacy: what stays on your computer

Everything runs locally: the database, the dashboard (it only answers on `127.0.0.1`) and the CLI. What leaves your computer:

- requests to job boards and ATS APIs (no personal data; LinkedIn is searched as a guest, your account is never used);
- the AI prompts, which contain your CV, profile and the job description: to Anthropic through the Claude CLI, or to the API provider you chose (nothing leaves with a local Ollama);
- the Dutch IND sponsor register download, if you use it.

Gitignored, never committed: `.env`, `web/.env.local`, `cv/applicant.json`, `cv/versions/` (generated CVs), `applications/` (letters per job) and `data/` (logs, HTTP cache, IND register, backups).

**Tracked by git:** `config.json`, `cv/master.json`, `cv/default/` and `cv/original/`. If you commit your own CV there, keep your copy of the repository private.
