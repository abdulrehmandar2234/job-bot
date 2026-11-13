# Quickstart

From nothing to your first matching jobs in about ten minutes, plus the time to write your CV. This page is the short path; the [install guide for your computer](README.md#1-install-it-on-your-computer) explains every step and its problems.

## What you need first

- **Git**, **Node.js 24+** and **PostgreSQL 15+**, running on your computer.
- For the AI features, one of: the [Claude Code CLI](ai.md#option-1-the-claude-code-cli), signed in, or [one API key](ai.md#option-2-one-api-key) of any OpenAI-compatible provider. Without either, Talaash still finds and filters jobs and writes template letters ([running without AI](ai.md#running-without-ai)).

| Your computer                                   | Full guide                               |
| ----------------------------------------------- | ---------------------------------------- |
| macOS                                           | [Install on macOS](install/macos.md)     |
| Linux (Ubuntu / Debian; notes for Fedora, Arch) | [Install on Linux](install/linux.md)     |
| Windows 10 / 11 (PowerShell)                    | [Install on Windows](install/windows.md) |
| Any of them, with Docker                        | [Run with Docker](install/docker.md)     |

## 1. Get the code

```bash
git clone https://github.com/abdulrehmandar2234/talaash.git && cd talaash
npm install && npm --prefix web install
npx playwright-core install chromium-headless-shell   # prints CVs and letters to PDF
```

## 2. Run the setup wizard

```bash
npm run bot -- setup     # writes .env, creates the database, starts your CV, asks for your profile and markets
npm run bot -- doctor    # checks the whole setup and says how to fix what is missing
```

The wizard offers ready-made **presets**: markets (`gulf`, `india`, `netherlands`, `pakistan`) set the countries and company boards, stacks (`php-laravel`, `javascript`, `python`) the keywords and job-title rules. Your answers go into `config.json` and `cv/applicant.json`, which stay on your computer and are never committed. [Configuration](configuration.md#presets) explains what the presets set.

## 3. Put in your CV

`cv/master.json` starts as the fictional Jane Doe. Replace it with your own CV ([the format, field by field](your-cv-and-profile.md#your-cv-cvmasterjson)). The quickest way is to import the CV you already have: `npm run bot -- cv:import my-cv.pdf`, read the draft it saves, then `npm run bot -- cv:import --apply` ([how it works](your-cv-and-profile.md#import-the-cv-you-already-have)). Then:

```bash
npm run bot -- cv:default   # your CV as a PDF
```

## 4. Fetch jobs and open the dashboard

```bash
npm run bot -- fetch        # the first jobs, a few minutes
npm run web                 # the dashboard on http://localhost:3100
```

The **Matching** tab lists the jobs that passed your filters, best match first.

## Next steps

- [Daily use](daily-use.md): the job list, preparing a CV and letter, the Chrome extension, follow-ups.
- The morning run: step 12 of your install guide sets up `bot daily` once a day, 09:00 unless you choose another time (fetch, AI review, notification, backup).
- [Features](features.md): everything Talaash can do, and every job source.
- [How it works](how-it-works.md): the architecture and the path of one job.
