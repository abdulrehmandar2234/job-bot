# Your CV and profile

job-bot knows about you from two files you fill in yourself:

- **`cv/master.json`**: your CV as data. Every CV PDF, every AI prompt and the keyword match read it.
- **`cv/applicant.json`**: your profile (where you live, languages, visa situation) and the facts application forms ask for (notice period, salary expectations, ...). `npm run bot -- setup` or the dashboard's **Settings** page creates it.

This page explains both, field by field, then the CV templates and versions and the AI writing features built on them: cover letters, CV summaries, feedback and reviews.

Back to the [start page](README.md). Target markets and filters are in [configuration.md](configuration.md).

Contents:

- [The one rule: only true facts](#the-one-rule-only-true-facts)
- [Your CV: `cv/master.json`](#your-cv-cvmasterjson)
- [The setup wizard](#the-setup-wizard)
- [Your profile: `cv/applicant.json`](#your-profile-cvapplicantjson)
- [CV templates](#cv-templates)
- [CV versions and the per-stack framings](#cv-versions-and-the-per-stack-framings)
- [Cover letters](#cover-letters)
- [A CV summary for one job](#a-cv-summary-for-one-job)
- [Improving a job's CV with feedback](#improving-a-jobs-cv-with-feedback)
- [The CV keyword check](#the-cv-keyword-check)

## The one rule: only true facts

The bot only re-orders, re-frames, shortens or selects what is in `cv/master.json`. It never adds a skill, employer, number or claim, and the AI prompts only allow facts from your CV and profile (tests check this). So anything missing from your CV will never appear in a letter, answer or CV version: put everything true and relevant in it.

## Your CV: `cv/master.json`

The repository's `cv/master.json` is the original owner's CV. Start from the fictional example and replace it with yourself:

```bash
cp cv/master.example.json cv/master.json          # Windows PowerShell: Copy-Item cv\master.example.json cv\master.json -Force
```

The file is not schema-validated like `config.json`: every field below must be present with the right type, or rendering the PDF fails (`projects` and `education` may be empty arrays).

| Field              | Type                        | What it is                                                                                                                                                                                                    | Example                                                                                            |
| ------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `name`             | string                      | Your name, the CV heading and the letter header. Also the fallback for `fullName` in your profile.                                                                                                            | `"Jane Doe"`                                                                                       |
| `title`            | string                      | Your headline under the name.                                                                                                                                                                                 | `"Full Stack Engineer"`                                                                            |
| `contact.phone`    | string                      | Phone, international format. Fallback for the profile's `phone`.                                                                                                                                              | `"+351 900 000 000"`                                                                               |
| `contact.email`    | string                      | Email. Fallback for the profile's `email`.                                                                                                                                                                    | `"jane.doe@example.com"`                                                                           |
| `contact.location` | string                      | "City, Country" as shown on the CV. Last fallback for your location.                                                                                                                                          | `"Lisbon, Portugal"`                                                                               |
| `contact.linkedin` | string                      | Full LinkedIn URL. Fallback for the profile's `linkedin`.                                                                                                                                                     | `"https://www.linkedin.com/in/jane-doe/"`                                                          |
| `summary`          | string                      | The paragraph at the top of the CV. The AI's per-job CV summary is written "in the voice of your current summary", so make this one good.                                                                     | 2–4 sentences                                                                                      |
| `skills`           | array of `{ group, items }` | Skill groups, each a name and a list of skills. **A job's skill counts as yours only when it is listed here** (see the keyword score in [configuration.md](configuration.md#how-filtering-and-scoring-work)). | `{ "group": "Databases & ORMs", "items": ["PostgreSQL", "Prisma"] }`                               |
| `experience`       | array                       | One entry per job, newest first: `role`, `company`, `location`, `dates`, `tags` (array of strings), `bullets` (array of strings).                                                                             | see below                                                                                          |
| `projects`         | array                       | `name`, `url` (a full URL; shown without `https://`), `tags` (array), `text` (one or two sentences).                                                                                                          | see below                                                                                          |
| `education`        | array                       | `school`, `degree`, `dates`.                                                                                                                                                                                  | `{ "school": "University of Example", "degree": "BSc, Computer Science", "dates": "2016 — 2020" }` |

One experience entry and one project, from `cv/master.example.json`:

```json
{
  "role": "Full Stack Engineer",
  "company": "Example Travel",
  "location": "Lisbon, Portugal",
  "dates": "Jan 2023 — Present",
  "tags": ["next", "mern"],
  "bullets": [
    "Built the booking platform with Next.js, Node.js and PostgreSQL, from the first commit to 50,000 monthly users.",
    "Designed the REST API and the database schema, and added Jest tests and a CI/CD pipeline."
  ]
}
```

```json
{
  "name": "Trip Planner",
  "url": "https://example.com/trip-planner",
  "tags": ["next"],
  "text": "An open-source trip planner built with Next.js and Prisma."
}
```

Good practice:

- **Bullets:** start with a verb in the past tense ("Built", "Designed", "Cut"), one achievement per bullet, with a number where you have a true one ("to 50,000 monthly users"). The **first bullet of each job stays first** in every CV version (it introduces the role); the others may be re-ordered per version, so make each one stand on its own.
- **Dates:** one format everywhere, e.g. `"Jan 2023 — Present"`, `"Jun 2020 — Dec 2022"`, `"2016 — 2020"`. They are printed as you write them.
- **Skills:** 4–7 groups with clear names. The built-in CV versions move groups called `Languages & Runtimes`, `Frameworks & Libraries`, `Databases & ORMs`, `APIs & Web`, `Testing & Practices` and `AI Tools & Agentic Development` to the front, so reuse those names where they fit. Use the common spelling of each skill (`Node.js`, `React.js`, `PostgreSQL`, `TypeScript`): the keyword match looks for patterns such as `node`, `react`, `postgres` in your skill items. Listing `MySQL` or `PostgreSQL` also proves "SQL".
- **Tags:** short lower-case words. Project `tags` decide which projects a CV version lists first: the built-in versions look for `laravel`, `fintech`, `mern`, `nest`, `next` and `ai`. Experience `tags` are stored with the CV but not used for ordering today.

Check and render it (no database needed for these two):

```bash
node -e "JSON.parse(require('fs').readFileSync('cv/master.json', 'utf8')); console.log('ok')"
npm run bot -- cv:preview classic --pdf      # data/previews/classic.pdf
```

Then, once the database is set up and `npm run bot -- setup` has set the PDF file name:

```bash
npm run bot -- cv:default    # writes cv/default/<cvFileName>
```

Run `cv:default` again after every change to `cv/master.json`. You may also keep your original PDF in `cv/original/`; the bot never changes it.

## The setup wizard

```bash
npm run bot -- setup
```

The wizard fills in your profile (`cv/applicant.json`) and your target markets (`config.json`). It needs no database. Every question shows the current value in `[brackets]`: **Enter keeps it**, **`-` clears it**. A wrong answer (bad email, bad code, invalid regular expression) is asked again. At the end both files are validated against the schemas in `src/settings.ts`, and nothing is written unless both are valid and you say yes. Run it again whenever you like, or edit the same fields on the Settings page.

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

| #   | Question                                                                                                                                    | Saved as                                                                     | Notes                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13p | Start from market presets, comma-separated                                                                                                  | `countries`, `linkedin.locations`, `adzuna.countries`, `companies`           | Enter keeps them. `gulf`, `india`, `netherlands`, `pakistan` ([presets](configuration.md#presets)); the next questions then show the preset's values.                           |
| 13  | Target countries for onsite jobs, two-letter codes                                                                                          | the keys of `countries`                                                      | At least one, e.g. `NL, AE`. Countries you leave out are removed.                                                                                                               |
| 13a | `<code>`: country name                                                                                                                      | `countries.<code>.name`                                                      | Required.                                                                                                                                                                       |
| 13b | `<code>`: location pattern (regular expression)                                                                                             | `countries.<code>.match`                                                     | Default: the lower-case name. Add cities and spellings, e.g. `amsterdam\|rotterdam\|netherlands\|\bnl\b`.                                                                       |
| 13c | `<code>`: visa route                                                                                                                        | `countries.<code>.visa`                                                      | `employer` (the employer arranges the permit) or `ind-register` (Netherlands: the company must be an IND recognised sponsor). Default `ind-register` for `NL`, else `employer`. |
| 13d | `<code>`: do you need a work visa there?                                                                                                    | `countries.<code>.needsVisa`                                                 | Default "n" for your own country code, else "y".                                                                                                                                |
| 14  | Also look for remote jobs?                                                                                                                  | `remote.enabled`                                                             |                                                                                                                                                                                 |
| 14a | Remote work from which country                                                                                                              | `remote.from` and `linkedin.remoteFrom`                                      | Only when remote is on. If `config.json` still names another country (a cloned config), the wizard proposes yours and shows the old one.                                        |
| 14b | Its two-letter code                                                                                                                         | `remote.fromCode`                                                            | Himalayas only lists jobs open to this country.                                                                                                                                 |
| 14c | Remote regions that include you (regular expression; Enter = automatic)                                                                     | `remote.allow`                                                               | Enter = computed from your country ([Remote regions](configuration.md#remote-regions)). A pattern you wrote is offered again only while the country stays the same.             |
| 14d | Remote regions that exclude you (regular expression; Enter = automatic)                                                                     | `remote.deny`                                                                | Enter = computed from your country.                                                                                                                                             |
| 15  | LinkedIn onsite search locations, comma-separated                                                                                           | `linkedin.locations`                                                         | As you would type them in LinkedIn's location box. Default: the country names.                                                                                                  |
| 15p | Start from stack presets, comma-separated                                                                                                   | `linkedin.keywords`, `remote.himalayasQueries`, `roleInclude`, `roleExclude` | Enter keeps them. `php-laravel`, `javascript`, `python` ([presets](configuration.md#presets)).                                                                                  |
| 16  | Claude CLI or API key (claude-cli / api)                                                                                                    | `ai.provider`                                                                | See [ai.md](ai.md).                                                                                                                                                             |
| 16a | (claude-cli) Path to the Claude Code CLI                                                                                                    | `ai.claudePath`                                                              | `which claude` on macOS and Linux; `where.exe claude` in PowerShell (the wizard's hint says `where claude`, which is a different command in PowerShell).                        |
| 16b | (api) Which provider (`auto`, `openai`, `deepseek`, `anthropic`, `gemini`, `groq`, `openrouter`, `mistral`, `together`, `ollama`, `custom`) | `ai.api.preset`                                                              | `auto` removes the preset, so it is detected from the key. The wizard **never asks for the key**: it reminds you to put `AI_API_KEY=...` in `.env`.                             |
| 16c | (custom only) base URL, model for scoring, model for writing                                                                                | `ai.api.baseUrl`, `ai.api.scoreModel`, `ai.api.letterModel`                  | An empty base URL means `AI_BASE_URL` in `.env`.                                                                                                                                |
| 17  | File name of your CV PDF                                                                                                                    | `cvFileName`                                                                 | Letters, digits, `_`, `.`, `-`, ending in `.pdf`. Default `<your_name>_resume.pdf`.                                                                                             |

Then it asks `Save cv/applicant.json and config.json? (y/n)`, lists any profile fields still missing, and prints the next steps.

Apart from the presets, the wizard does **not** touch the rest of `config.json`: `companies`, `roleInclude` / `roleExclude`, `linkedin.keywords`, `remote.himalayasQueries` and the rest keep the values from `config.default.json` (the owner's). Review them in [configuration.md](configuration.md).

## Your profile: `cv/applicant.json`

The setup wizard or the Settings page creates it; `cv/applicant.example.json` shows a fictional person. It is gitignored. Every key is optional (a missing fact counts as unknown), extra keys are allowed and passed to the AI as they are, and the file is validated on every start.

For form answers, **`null` means unknown**: the AI then writes `[FILL: ...]` (highlighted) instead of guessing. Fill in what you are happy for the bot to state.

| Key                     | Type                                       | Used for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Example                                                                              |
| ----------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `_help`                 | string                                     | A note for humans; ignored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |                                                                                      |
| `fullName`              | string or null                             | Letter and follow-up signatures, extension form fill. Missing: `cv/master.json` `name`.                                                                                                                                                                                                                                                                                                                                                                                                                                        | `"Jane Doe"`                                                                         |
| `email`                 | email, `""` or null                        | Signatures. Missing: the CV's email.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `"jane.doe@example.com"`                                                             |
| `phone`                 | string or null                             | Signatures. Missing: the CV's phone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `"+351 900 000 000"`                                                                 |
| `linkedin`              | URL, `""` or null                          | Signatures. Missing: the CV's LinkedIn.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `"https://www.linkedin.com/in/jane-doe/"`                                            |
| `city`, `country`       | string or null                             | Where you live: letters, AI prompts ("the candidate is based in ..."), the default remote-from country.                                                                                                                                                                                                                                                                                                                                                                                                                        | `"Lisbon"`, `"Portugal"`                                                             |
| `countryCode`           | two capital letters or null                | Where you live (ISO 3166-1 alpha-2). A target country with this code never needs a visa; Himalayas default country.                                                                                                                                                                                                                                                                                                                                                                                                            | `"PT"`                                                                               |
| `utcOffset`             | `GMT±H[:MM]` / `UTC±H[:MM]` or null        | Remote letters and prompts; Himalayas time-zone limits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `"GMT+0"`                                                                            |
| `currentLocation`       | text or null                               | Form answers; the extension's location field.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `"Lisbon, Portugal"`                                                                 |
| `languages`             | text or null                               | AI screening and the language filter (split on `,` `/` `;` `and` `&`).                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `"English, Portuguese"`                                                              |
| `workAuthorization`     | text or null                               | Form answers and prompts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `"Portuguese citizen: may work anywhere in the EU without a visa."`                  |
| `needsVisaSponsorship`  | text, boolean or null                      | Form answers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `"Only for onsite roles outside the EU."`                                            |
| `willingToRelocate`     | text, boolean or null                      | Form answers; "Yes..." (or `true`) adds relocation to letters.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `"Yes"`                                                                              |
| `nationality`           | text or null                               | Form answers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `"Portuguese"`                                                                       |
| `noticePeriod`          | text or null                               | Form answers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `"1 month"`                                                                          |
| `earliestStartDate`     | text or null                               | Form answers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `"Two weeks after an offer"`                                                         |
| `currentSalary`         | text, number or null                       | Form answers (leave null if you would rather not say).                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `null`                                                                               |
| `expectedSalary`        | object: country key → text, number or null | Form answers, and the dashboard's "below your expectation" hint (a hint only, never a filter). Keys are your `countries` codes plus `"remote"`. A plain number is read in the country's currency from `src/currencies.json` (USD for `remote`), per month in the Gulf (`AE`, `SA`, `QA`, `KW`, `BH`, `OM`) and per year elsewhere; text can name its own currency and period. Indian amounts may use lakh, crore or LPA (`"18 LPA"`, `"₹18,00,000"`). "Rs" follows the key's country, and for `remote` your own `countryCode`. | `{ "NL": 70000, "AE": "AED 25,000 per month", "remote": "USD 60k per year" }`        |
| `workingHoursForRemote` | text or null                               | Form answers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `"Any overlap with CET"`                                                             |
| `howDidYouHear`         | text or null                               | Form answers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `"LinkedIn"`                                                                         |
| `coverLetter`           | object                                     | Sentences of the **template** letter, used when the AI is off or fails. Missing ones are left out.                                                                                                                                                                                                                                                                                                                                                                                                                             |                                                                                      |
| `coverLetter.intro`     | text or null                               | Opening sentence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `"I am a Full Stack Engineer with 5 years of experience building web applications."` |
| `coverLetter.pitch`     | object: CV cluster → text                  | One pitch per CV cluster (`laravel`, `mern`, `next-nest`, ...), plus `default`.                                                                                                                                                                                                                                                                                                                                                                                                                                                | `{ "default": "Most recently I built ..." }`                                         |
| `coverLetter.strengths` | text or null                               | Follows "Your posting asks for X, which is the core of my day-to-day work."                                                                                                                                                                                                                                                                                                                                                                                                                                                    |                                                                                      |
| `coverLetter.remote`    | text or null                               | Follows "I am based in <location> (<UTC offset>)," in remote letters.                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `"have worked remotely with distributed teams across Europe"`                        |
| `other`                 | object: question → fact                    | Anything else forms ask (e.g. `"Driving licence": "Yes, EU B"`).                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `{}`                                                                                 |

The dashboard shows a banner ("Welcome! Set up your profile first." or "Your profile is incomplete.") until your profile has a **name, email, location, country code and languages** (name, email and location may come from `cv/master.json`).

## CV templates

Every CV can be rendered in one of three ATS-safe designs (one text column, real text, standard section names, no images or tables):

- **classic**: the original design;
- **modern**: a teal name banner and accent colour, skills as short text lines;
- **compact**: smaller font and tighter spacing, to fit more on one page.

```bash
npm run bot -- cv:templates                   # list them, and which one is the default
npm run bot -- cv:preview modern --pdf        # your master CV in a design: data/previews/modern.pdf
npm run bot -- cv:template <id> compact       # use a design for one job: re-renders its CV as a new version
```

`config.json` → `cvTemplate` sets the default (missing = classic); the Settings page has it as **CV template**. A job can use its own: `cv:template`, or **Apply template** on the job page. A CV you may already have sent is never overwritten: a new template makes a new version. `prepare`, `cv:tailor` and `custom` use the job's template.

## CV versions and the per-stack framings

The default CV (`cv/default/<cvFileName>`) is your master CV as you wrote it. On top of it, job-bot can build **versions per stack cluster** (`laravel`, `tall`, `laravel-vue`, `mern`, `pern`, `next-nest`, `backend-node`, `frontend-react`, `ai-fullstack`): each moves the matching skill groups, bullets and projects forward and uses a headline and summary for that stack. Versions live in `cv/versions/<cluster>-v<N>/` (`<cluster>-<template>-v<N>/` in another template); every PDF has the same file name, and the folder name identifies the version. Versions are reused, and only rebuilt (`v2`, `v3`, ...) when the master CV, the framings or the template change. `npm run bot -- versions` lists them and how many jobs use each.

> **The per-stack framings are the original owner's.** `src/cv/profiles.ts` holds a headline and summary per stack cluster written for the owner's CV. Keep `"autoCvVersions": false` in `config.json` and do not use `prepare --cv <cluster>`, `cv:build` or `custom` until you have rewritten those profiles for yourself, or the PDF gets the owner's headline and summary. With `autoCvVersions: false`, `prepare` always uses your default CV. `cv:tailor` and `cv:feedback` are safe: they start from the job's current CV, which with `autoCvVersions: false` is your default CV.

One-off CVs for a single job go to `cv/versions/custom-<company-role>-v<N>/`, a new folder every time, so a CV you already sent is never overwritten. They come from `cv:tailor`, `cv:feedback`, `cv:template` and `custom <id> --overrides o.json` (an overrides file with `title`, `summary`, `skillsFirst`, `groupsFirst`, `projectTags`, `bulletKeywords`).

Each version folder has `cv.json` (the data it was rendered from) and `meta.json` (cluster, template, master hash, the job for one-off versions, and, for a CV revised with feedback, what was left out).

## Cover letters

A cover letter is never written automatically. **Write letter** on the job page, `npm run bot -- letter <id>`, or `prepare <id> --letter` writes one:

- **With AI** (the letter model): from the job description and your CV, using only true facts and making no promises about salary, notice period or start date. It is signed with the name and contact in your profile.
- **Template** (when `ai.enabled` is false, the AI fails, or with `letter <id> --template`): built from your profile's `coverLetter` sentences (introduction, a pitch per CV cluster, how you work, remote experience), where you live and your visa need.

To change a letter, say what should change: **What should change?** → **Rewrite with feedback** on the job page, or

```bash
npm run bot -- letter <id> --feedback "shorter, and less formal"
```

The AI rewrites the current letter with the same rules. If the feedback asks for something your CV does not show, it leaves it out and says so in a short note. Or click **Edit**, change it yourself and **Save** (no AI; the label then says "edited by you").

**Download PDF** (or `npm run bot -- letter:pdf <id>`) prints a one-page PDF in the CV's style, with your name and contact as the header, to `cover-letter.pdf` in the job's folder under `applications/` (`<date>-<company>-<title>`).

## A CV summary for one job

The AI (letter model) can rewrite the summary at the top of your CV for one job: 3–4 sentences, 50–90 words, in the voice of your current summary, with only facts from your CV (no new skills, years or numbers, no promises).

```bash
npm run bot -- summary <id>                          # write it
npm run bot -- summary <id> --feedback "mention the fintech work first"   # rewrite it with feedback
npm run bot -- cv:tailor <id>                        # build a one-off CV with it, set as the job's CV
```

On the job page: **CV summary for this job** → **Write summary**, then **Rewrite summary**, **Copy**, **Use in my CV for this job** (`cv:tailor`), and the same **What should change?** and **Edit** as the letter.

## Improving a job's CV with feedback

```bash
npm run bot -- cv:feedback <id> --feedback "put the React experience first, fit on one page"
npm run bot -- cv:review <id>
```

`cv:feedback` (at most 1000 characters of feedback; **Improve CV with feedback** on the job page) has the AI revise the job's CV from the job description, your master CV and the job's current CV. It may only reorder, re-frame, shorten or select what `cv/master.json` has: the title and summary wording, the order and selection of skill groups, skills, bullets and projects. The reply is then checked in code (`src/cv/feedback.ts`): every employer, bullet, skill group, skill and project must match the master CV, a new title or summary may not name a skill or number the master does not have, and employers are never dropped. Anything else is left out and listed under the AI's note. The result is a new one-off version in the job's template, made the job's CV.

`cv:review` (**Suggest improvements**) stores a short, honest AI review of the CV against the job (what is weak or missing, what to put first). **Use as feedback** copies it into the feedback box.

Both need the AI: with `ai.enabled: false` they stop with a message.

## The CV keyword check

```bash
npm run bot -- ats <id> [--cv <cluster>] [--json]
```

Also on the job page. It splits the job's skill keywords into those the CV version shows near the top, those you have (in `cv/master.json`) but this version keeps further down, and real gaps that are not on your CV at all, and names the CV version that shows the most of them. Gaps are only listed, never added on their own.

On the job page, tick **I have this** for a gap you really have (with an optional note for the AI) and **Add to my CV and improve it for this job** (`npm run bot -- cv:feedback <id> --add-skills "Docker,GraphQL"`): only the ticked skills go into `cv/master.json`, in the group that fits them, and the job's CV is revised to show them. A copy of `cv/master.json` is saved to `data/cv-backups/` first; the daily run keeps the newest 20 copies and deletes older ones.
