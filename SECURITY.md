# Security

Talaash runs on your own computer and holds personal data: your CV, your profile, your applications and, if you use one, an AI API key. Please report anything that could expose that data or let someone else act through Talaash.

## Reporting a vulnerability

Report it privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability**. Please do not open a public issue for a security problem.

Say what is affected, how to reproduce it, and what an attacker could do with it. You get an answer within a week. Once a fix is released, the report is published with credit to you, unless you prefer otherwise.

Only the latest release and the `main` branch get security fixes.

## What is in scope

- The dashboard (`web/`): it should only answer on `127.0.0.1` and refuse other hosts, and `/api/import` should only accept the pinned Chrome extension or the import token.
- The Chrome extension (`extension/`): it should only talk to the local dashboard and never submit a form.
- The bot (`src/`): the API key must never appear in logs, error messages or the dashboard; job postings are untrusted input and must not steer the AI or run anything.
- Files written by Talaash, such as backups and the settings files.

## What is not

- Problems in job sites, AI providers or other services Talaash reads from: report those to their owners.
- Attacks that need someone who already controls your computer or your user account.
- Running the dashboard on a public network on purpose, against the documentation.

## Keeping your own install safe

- Keep `.env` (your `AI_API_KEY`) and the files under `cv/`, `data/` and `applications/` to yourself: they are gitignored, so do not force-add them to a public fork.
- Keep Talaash up to date ([Updating](docs/updating.md)).
