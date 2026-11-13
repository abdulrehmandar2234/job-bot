# Changelog

What changed in each version of Talaash. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/): before 1.0.0, a minor version (0.2.0) may change settings or commands, and its notes say how to update. [ROADMAP.md](ROADMAP.md) lists what is planned.

To update an existing install, see [Updating](docs/updating.md): pull the new version, run `npm install` (and `npm --prefix web install`), and the database migrates itself on the next command.

## [Unreleased]

## [0.1.0] - 2026-11-13

The first release: everything Talaash does today, used daily for one real job search since October 2026.

### Finding jobs

- Company career boards: Greenhouse, Lever, Ashby, Recruitee, Workable, SmartRecruiters, Workday and Personio.
- Job boards: Himalayas, Remotive, RemoteOK, Jobicy, Arbeitnow, Adzuna, Hacker News "Who is hiring" and freehire.me.
- LinkedIn's public guest search, paced and stopped on rate limits; Bayt through a helper script; any job page through the Chrome extension.
- `discover` finds a company's job board by name; a daily run (`bot daily`) at a time you choose on macOS, Linux and Windows, with a desktop notification.

### Filtering and scoring

- Filters for target countries, visa needs (with the Dutch IND sponsor register and its salary minimum), remote regions open to where you live, title, job type, language, posting age, passed deadlines and hidden companies, each with the reason kept.
- A keyword score against your CV per stack preset, and an AI review (0–100, verdict, reasons, gaps, red flags, location check).
- Postings are treated as data: hidden text and invisible characters are dropped, and text aimed at AI tools is flagged.
- Duplicates found on several sites are grouped into one job.

### Preparing applications

- CV versions per stack, three CV templates, a CV headline and summary per job, CV feedback and review, and a CV keyword check. CVs only ever re-frame what is in your master CV.
- `cv:import` reads the CV you already have (PDF, Word, text) into a draft master CV.
- Cover letters from the AI, checked against your CV and the posting before they are stored, or from a template; letters as PDF.
- Drafted answers to application-form questions, interview prep and follow-up messages.
- The Chrome extension fills empty form fields with the prepared values when you click. It never submits.

### Tracking

- A local dashboard: job list with filters, tabs and keyboard triage, job pages, status history with Undo, contacts and referral reminders, company history, follow-up reminders, application deadlines, settings and analytics (funnel, response rates, skills radar, skip patterns, fetch health).

### Running it

- Node.js 24+ and PostgreSQL, or Docker (`docker compose up -d`).
- The AI is the Claude Code CLI you are signed in to, or one API key of any OpenAI-compatible provider (or a local model), or off.
- Setup wizard, `doctor`, daily backups, and a documentation site.

[Unreleased]: https://github.com/abdulrehmandar2234/talaash/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/abdulrehmandar2234/talaash/releases/tag/v0.1.0
