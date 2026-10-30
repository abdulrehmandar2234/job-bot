# Updating job-bot

How to get a newer version. The steps are the same on every OS; only the terminal differs (PowerShell on Windows).

Back to the [start page](README.md).

## 1. Stop the dashboard

In the terminal where `npm run web` runs, press Ctrl+C.

## 2. Pull the new code

```bash
cd ~/job-bot             # Windows: cd $HOME\job-bot
git pull
```

`config.json` and `cv/master.json` are tracked files. If you changed them (you will have), `git pull` may stop with a conflict on them. Keep your versions:

```bash
git stash                # put your changes aside
git pull
git stash pop            # bring them back; fix any conflict it reports, keeping your values
```

Or keep your own branch (`git switch -c mine`, commit your files there) and merge `main` into it after each `git fetch`. `cv/applicant.json`, `.env` and `web/.env.local` are not tracked, so a pull never touches them.

## 3. Install the packages

When `package.json` or a lockfile changed (or when unsure):

```bash
npm install
npm --prefix web install
```

When `playwright-core` was updated, install the matching Chrome headless shell too (PDFs need it):

```bash
npx playwright-core install chromium-headless-shell
```

## 4. Apply the database migrations

New versions may add database columns (numbered SQL files in `src/migrations/`). The bot applies the ones the database has not run yet before any command that uses the database, and the **dashboard applies them when it starts** (`npm run bot -- migrate` in the background), recording them in `schema_migrations`. To apply them yourself:

```bash
npm run bot -- stats
```

(The next fetch would apply them too.) Never edit a migration file yourself.

## 5. Check the settings

New settings are optional or come with defaults, but a check costs nothing:

```bash
npm run bot -- settings:check --kind config --file config.json          # {"ok":true}
npm run bot -- settings:check --kind applicant --file cv/applicant.json
```

## 6. Restart the dashboard and reload the extension

```bash
npm run web
```

Then open `chrome://extensions` and press the reload icon on job-bot's card, so Chrome loads the new extension files.

## 7. The daily run

Nothing to do: it runs the code in the project folder, so it uses the new version from its next run. Only if you moved the project or changed your Node installation, run `npm run bot -- schedule:print` again and update the scheduler entry (see your install guide, step 12).

**Check it worked:** the dashboard loads without a database error, and `npm run bot -- daily` (or the next 9:00 run) writes a normal run to `data/fetch.log`.
