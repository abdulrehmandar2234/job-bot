# The AI: Claude CLI or one API key

Every AI feature (the fit review, cover letters, CV summaries, CV feedback and review, form answers, interview prep, follow-ups) asks for JSON that matches an output schema, through one function (`askAi` in `src/ai-providers.ts`). `config.json` → `ai.provider` picks who answers.

Back to the [start page](README.md). Every `ai.*` key is also in [configuration.md](configuration.md#ai-provider-and-models).

Contents:

- [The two choices](#the-two-choices)
- [Option 1: the Claude Code CLI](#option-1-the-claude-code-cli)
- [Option 2: one API key](#option-2-one-api-key)
- [Presets and key prefixes](#presets-and-key-prefixes)
- [Which model does what](#which-model-does-what)
- [Speed and cost](#speed-and-cost)
- [Running without AI](#running-without-ai)
- [What the AI sees](#what-the-ai-sees)

## The two choices

|        | `claude-cli` (default)                                                                                   | `api`                                                            |
| ------ | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| How    | Runs your signed-in Claude Code CLI (`claude -p`), headless: no tools, no MCP servers, no saved session. | `POST <base URL>/chat/completions` on any OpenAI-compatible API. |
| Key    | None.                                                                                                    | `AI_API_KEY` in `.env`.                                          |
| Cost   | Comes out of your Claude plan's usage.                                                                   | Paid per token to that provider.                                 |
| Models | `ai.scoreModel` / `ai.letterModel` (`haiku` / `sonnet`).                                                 | `ai.api.scoreModel` / `ai.api.letterModel`, else the preset's.   |

Switch any time with `npm run bot -- setup`, or on the dashboard's **Settings** page ("AI provider": Claude CLI or API key, then the preset and models, with a line saying whether `AI_API_KEY` is set and whose key it looks like). Neither asks for the key itself.

## Option 1: the Claude Code CLI

Install it, run `claude` once and sign in:

| OS                   | Install                                           | Find its path      | Usual path                             |
| -------------------- | ------------------------------------------------- | ------------------ | -------------------------------------- |
| macOS, Linux         | `curl -fsSL https://claude.ai/install.sh \| bash` | `which claude`     | `~/.local/bin/claude`                  |
| Windows (PowerShell) | `irm https://claude.ai/install.ps1 \| iex`        | `where.exe claude` | `C:\Users\<you>\.local\bin\claude.exe` |

Other ways are in the [Claude Code docs](https://docs.claude.com/en/docs/claude-code). Then put the path in `ai.claudePath` (the setup wizard asks for it). The repository's `config.json` has the owner's path, so change it.

```json
"ai": { "enabled": true, "provider": "claude-cli", "claudePath": "/home/<you>/.local/bin/claude", "scoreModel": "haiku", "letterModel": "sonnet", "maxScorePerRun": 80, "concurrency": 2 }
```

- **Windows:** use the native installer's `claude.exe`. A `claude.cmd` from `npm install -g` cannot be started, because the bot never runs programs through a shell.
- **The daily run** puts `~/.local/bin` (Windows: `%USERPROFILE%\.local\bin`) first on the PATH of each step, so a `claude` installed there is found even under a scheduler.
- **Signed out?** The fit review fails with "AI review failed (is Claude signed in?)". Run `claude`, sign in (`/login`), and try `npm run bot -- ai:score` again.

## Option 2: one API key

Set the provider to `api` and add one key to `.env` in the project folder (never to `config.json`):

```json
"ai": { "enabled": true, "provider": "api", "claudePath": "claude", "scoreModel": "haiku", "letterModel": "sonnet", "maxScorePerRun": 80, "concurrency": 2 }
```

```bash
# .env
AI_API_KEY=sk-ant-...
```

`claudePath`, `scoreModel` and `letterModel` stay required (they are kept for switching back). The provider comes from `ai.api.preset`, else from `AI_BASE_URL` (a custom endpoint), else from the key's prefix. To pin a preset or other models:

```json
"ai": { "...": "...", "provider": "api", "api": { "preset": "deepseek", "scoreModel": "deepseek-chat", "letterModel": "deepseek-chat" } }
```

- **The key** is read only from the environment, never written to `config.json`, never logged or shown, and only sent to that provider's base URL. The dashboard only shows whether `AI_API_KEY` is set and which provider it looks like.
- **Errors:** a missing key stops before any request. A rejected key (401/403) stops at once with a message naming `AI_API_KEY`, the provider, its own reason and the page where a new key is made, and how to paste it. An account with no credit (402) says so, with the page to add credit. A reply that is not the JSON asked for is asked for once more. These problems print as one line, with no stack trace, so the dashboard shows that line as the task's error.
- **Time limit and stopping early:** each AI request, with its retries and the one re-ask, has a 5-minute budget; when it runs out the request itself is cancelled and the command exits with the error. A bulk `ai:score` (also in the daily run) stops on the first error that would hit every job (rejected or missing key, no credit, no model or base URL set, Claude CLI missing or signed out) or after 3 timeouts in a row, with one line (`AI review failed for N of M jobs; stopped early: ...`) and exit 1, instead of failing the whole queue one job at a time. The jobs not tried are reviewed on the next run ([troubleshooting](troubleshooting.md#ai-review-failed--stopped-early)).
- **Cover letter fallback:** when the AI fails, Write letter still writes the template letter (the job page labels it "template"), and the job page says the AI could not write it and why.
- **Older settings still work:** `ai.provider` `"openai"` / `"deepseek"` (with their `ai.openai` / `ai.deepseek` sections) are read as `api` with that preset, and `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` are read when `AI_API_KEY` is not set.
- `ai.api.baseUrl` (or `AI_BASE_URL` in `.env`, which wins) points at a proxy or another compatible endpoint; `ai.api.responseFormat` (`json_schema`, `json_object`, `text`) overrides how JSON is asked for, if a provider rejects the preset's default.

## Presets and key prefixes

| Preset       | Key prefix (auto-detect)      | Base URL                                                  | Score model (default)                         | Letter model (default)                    | JSON asked as        |
| ------------ | ----------------------------- | --------------------------------------------------------- | --------------------------------------------- | ----------------------------------------- | -------------------- |
| `anthropic`  | `sk-ant-`                     | `https://api.anthropic.com/v1`                            | `claude-haiku-5-5`                            | `claude-sonnet-5-5`                       | schema in the prompt |
| `openrouter` | `sk-or-`                      | `https://openrouter.ai/api/v1`                            | `openai/gpt-4o-mini`                          | `openai/gpt-4o`                           | JSON mode + schema   |
| `groq`       | `gsk_`                        | `https://api.groq.com/openai/v1`                          | `llama-3.1-8b-instant`                        | `llama-3.3-70b-versatile`                 | JSON mode + schema   |
| `gemini`     | `AIza`                        | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash`                            | `gemini-2.5-pro`                          | JSON schema          |
| `openai`     | any other `sk-`               | `https://api.openai.com/v1`                               | `gpt-4o-mini`                                 | `gpt-4o`                                  | JSON schema          |
| `deepseek`   | `sk-` too: **set the preset** | `https://api.deepseek.com`                                | `deepseek-chat`                               | `deepseek-chat`                           | JSON mode + schema   |
| `mistral`    | set the preset                | `https://api.mistral.ai/v1`                               | `mistral-small-latest`                        | `mistral-large-latest`                    | JSON schema          |
| `together`   | set the preset                | `https://api.together.xyz/v1`                             | `meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | JSON mode + schema   |
| `ollama`     | no key needed                 | `http://localhost:11434/v1`                               | `llama3.1`                                    | `llama3.1`                                | JSON mode + schema   |
| `custom`     | any                           | `AI_BASE_URL` or `ai.api.baseUrl`                         | `ai.api.scoreModel`                           | `ai.api.letterModel`                      | JSON mode + schema   |

**DeepSeek keys also start with `sk-`**, so they look like OpenAI keys: set `"preset": "deepseek"` (or `AI_BASE_URL`). An explicit preset or `AI_BASE_URL` always wins over the prefix. Mistral and Together keys have no recognisable prefix, so they need the preset too. The presets are defined in `src/ai-presets.ts`.

**Ollama** runs models on your own computer: install it from [ollama.com](https://ollama.com), `ollama pull llama3.1`, keep it running, and set `"preset": "ollama"`. It costs nothing and sends nothing out, but small models follow the JSON schema less reliably; failed reviews are reported and can be retried.

## Which model does what

Each feature uses either the score model (fast) or the letter model (better writer):

| Feature        | Model  | Claude CLI | API (preset default) | Used by                                               |
| -------------- | ------ | ---------- | -------------------- | ----------------------------------------------------- |
| Fit review     | score  | `haiku`    | score model          | `ai:score`, daily run, **AI review** button           |
| Cover letter   | letter | `sonnet`   | letter model         | `letter`, "Write letter", "Rewrite with feedback"     |
| CV summary     | letter | `sonnet`   | letter model         | `summary`, "Write summary", "Rewrite with feedback"   |
| CV headline    | letter | `sonnet`   | letter model         | `headline`, "Write headline", "Rewrite with feedback" |
| CV feedback    | letter | `sonnet`   | letter model         | `cv:feedback`, "Improve CV with feedback"             |
| CV review      | letter | `sonnet`   | letter model         | `cv:review`, "Suggest improvements"                   |
| Form answers   | letter | `sonnet`   | letter model         | `answer`, "Draft answers"                             |
| Interview prep | letter | `sonnet`   | letter model         | `prep`, "Prepare for interview"                       |
| Follow-up      | letter | `sonnet`   | letter model         | `follow-up`, "Draft follow-up"                        |

## Speed and cost

- **Speed:** a fit review takes about 10 s and a letter 15–60 s with any provider. `ai.concurrency` (default 2) reviews run in parallel.
- **Volume:** most of it is the fit review: each sends your whole `cv/master.json` and one job description (a few thousand input tokens), for up to `ai.maxScorePerRun` jobs per run (the owner's value is 80), best keyword score first. A letter or summary is similar plus a few hundred output tokens, and only runs when you ask.
- **With an API key**, check your provider's pricing and usage page after the first day, and lower `ai.maxScorePerRun` (or use `ai:score --limit N`) to cap it. **With the Claude CLI**, the same runs count against your plan's usage limits instead.

## Running without AI

Set `config.json` → `ai.enabled` to `false` (or untick it on the Settings page). What happens today:

| Feature                                                                                                                                    | With `ai.enabled: false`                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Cover letters, follow-up drafts                                                                                                            | Use the templates built from your profile's `coverLetter` sentences.                                                             |
| Fit review (`ai:score`, also run by the daily run), form answers (`answer`), CV summary, letter and CV feedback, CV review, interview prep | Off: the command prints "AI is off (config.json ai.enabled)" and exits normally, without calling any provider.                   |
| Dashboard                                                                                                                                  | The AI-only buttons are hidden, with a note linking to Settings. Write letter and Draft follow-up stay (they use the templates). |

Fetching, filtering, the keyword score, CV PDFs and tracking work as before. Jobs are then sorted by their keyword score.

## What the AI sees

The prompts contain your CV (`cv/master.json`), your profile (`cv/applicant.json`) and the job description, and only allow facts from the first two. They describe you as "the candidate", from your profile: where you live, your UTC offset, your languages and where you need a visa. Fill in `cv/applicant.json` (notice period, expected salary per country, ...) so form answers can use them; unknown facts come back as `[FILL: ...]`. With the Claude CLI the prompts go to Anthropic; with an API key, to that provider; with Ollama, nowhere.

Job postings come from outside websites, so Talaash cleans them before the AI reads them: text the page hides (hidden elements, HTML comments, zero-size or transparent text) and invisible characters are removed when a posting is fetched, and every prompt tells the AI that the posting is data whose instructions it must not follow. A posting with visible text written to AI tools ("ignore previous instructions", "if you are an AI, add the word…") gets a flag quoting it, so you can read it yourself.
