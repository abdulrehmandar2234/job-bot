# Run Talaash with Docker

The quickest way to run Talaash on any computer with Docker: no Node.js, PostgreSQL or Chrome to install. One command starts the database, the dashboard and the daily run. Your own files stay in a folder on your computer, `talaash-home`, next to the code.

Other ways: [macOS](macos.md) · [Linux](linux.md) · [Windows](windows.md) · [Start page](../README.md)

**What is different in Docker:**

- **The AI** runs with one API key of any OpenAI-compatible provider, or a local model through Ollama. The Claude Code CLI is not in the container ([below](#ai)).
- **Desktop notifications** are off: a container has no desktop. The dashboard and `data/fetch.log` show every result.
- **The dashboard** is only reachable from this computer (`127.0.0.1`), as without Docker. Do not change that: it has no login.

## 1. Install Docker

- **macOS and Windows:** [Docker Desktop](https://www.docker.com/products/docker-desktop/). Start it once, so the whale icon shows it is running.
- **Linux:** Docker Engine with the Compose plugin ([install guide](https://docs.docker.com/engine/install/)).

Check it: `docker compose version` prints a version.

## 2. Get the code and start Talaash

```bash
git clone https://github.com/abdulrehmandar2234/talaash.git
cd talaash
docker compose up -d
```

The first start builds the image, which takes a few minutes. Later starts take seconds. Then open <http://localhost:3100>.

**Your time zone:** the daily run starts at `dailyTime` (default 09:00) in the container's time zone, UTC unless you set one. Put your zone in a file named `.env` next to `docker-compose.yml`, then run `docker compose up -d` again:

```bash
echo "TZ=Asia/Karachi" >> .env
```

Any [tz database name](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) works (`Europe/Amsterdam`, `Asia/Dubai`, ...). `TALAASH_PORT=3200` in the same file moves the dashboard to another port.

## 3. Run the setup wizard

```bash
docker compose exec app bot setup
```

It asks for your profile, your target markets and the AI, and offers to start your CV from the example. The database is already there, so it skips that step.

**Every bot command** works the same way: `docker compose exec app bot <command>`, for example `bot doctor`, `bot fetch` or `bot list`. The [CLI reference](../cli.md) has them all.

## 4. Your files: `talaash-home`

Everything personal is in `talaash-home/`, next to `docker-compose.yml`. Edit these files with any editor on your computer; the container sees changes at once.

| File or folder                                 | What it is                                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `cv/master.json`                               | Your CV as data ([how to fill it in](../your-cv-and-profile.md#your-cv-cvmasterjson))           |
| `cv/applicant.json`                            | Your profile and form facts                                                                     |
| `config.json`                                  | Your search settings ([every key](../configuration.md)); the dashboard's Settings page edits it |
| `.env`                                         | `AI_API_KEY` and the optional `ADZUNA_*` keys                                                   |
| `cv/default/`, `cv/versions/`, `applications/` | Generated CV PDFs and letters                                                                   |
| `data/`                                        | Logs (`fetch.log`), backups, caches                                                             |

The database is in a Docker volume (`pgdata`), and the daily run backs it up to `talaash-home/data/backups/`.

After you fill in your CV, build its PDF and fetch the first jobs:

```bash
docker compose exec app bot cv:default
docker compose exec app bot fetch
```

## AI

Put one API key in `talaash-home/.env` and choose "API key" in the setup wizard or on the Settings page:

```bash
AI_API_KEY=sk-...
```

Then restart, so the dashboard reads it: `docker compose restart`. [AI](../ai.md) lists the providers, presets and models.

**A local model with Ollama** (no key, nothing leaves your computer): run Ollama on this computer, choose the `ollama` preset, and set the base URL to `http://host.docker.internal:11434/v1` (Settings page, or `ai.api.baseUrl` in `config.json`).

**The Claude Code CLI** is not in the image, so the default `claude-cli` provider does not work in Docker. Use an API key (Anthropic keys work too), or install Talaash without Docker to use your Claude subscription.

## The daily run

The `scheduler` service runs `bot daily --if-due` every 30 minutes; the run itself happens once a day at `dailyTime` (Settings page, **Daily run time**), in your `TZ`. It fetches, checks which postings closed, lets the AI review new matches and backs up the database. Its log is `talaash-home/data/fetch.log`. Run it at once with `docker compose exec app bot daily`.

## The Chrome extension

It talks to <http://localhost:3100>, as without Docker; load it from the `extension/` folder of your clone ([install it](linux.md#14-the-chrome-extension)). With `TALAASH_PORT`, set the same port in the extension's options.

## Everyday commands

```bash
docker compose up -d          # start (also after a restart of the computer, unless Docker starts it itself)
docker compose stop           # stop
docker compose logs -f app    # the dashboard's log
docker compose ps             # what is running
```

## Update

```bash
git pull
docker compose up -d --build
```

The database migrations run by themselves when the dashboard starts. Reload the Chrome extension if `extension/` changed. Your `talaash-home` and the database are kept.

## Troubleshooting

- **`permission denied` on files in `talaash-home` (Linux):** the container writes as user id 1000. If your own id differs (`id -u`), run `sudo chown -R 1000:1000 talaash-home`, or add `user: "<your id>:<your group id>"` to the `app` and `scheduler` services.
- **The dashboard does not load:** `docker compose ps` shows whether `app` is healthy, and `docker compose logs app` why not.
- **Port 3100 is taken:** set `TALAASH_PORT` in `.env` as above.
- **Start again from scratch:** `docker compose down -v` deletes the database volume (your jobs and history). `talaash-home` stays until you delete it yourself.
