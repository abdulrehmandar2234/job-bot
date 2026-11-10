# Updating job-bot

How to get a newer version. The steps are the same on every OS; only the terminal differs (PowerShell on Windows).

Back to the [start page](README.md).

## 0. Back up first

Migrations only go forward: once a new version has changed the database, the way back is a backup. Take one now:

```bash
npm run bot -- backup    # prints backup: .../data/backups/job_bot-<date>.sql.gz
```

It holds the database only. `config.json`, `.env`, `cv/applicant.json`, your `cv/master.json` edits, `cv/versions/`, `applications/` and `data/import-token` are not in it; a pull leaves the untracked ones alone (see step 2), but copy any of them you want a safe copy of.

## 1. Stop the dashboard

In the terminal where `npm run web` runs, press Ctrl+C.

## 2. Pull the new code

```bash
cd ~/job-bot             # Windows: cd $HOME\job-bot
git pull
```

`config.json`, `cv/applicant.json`, `.env` and `web/.env.local` are not tracked, so a pull never touches them. New default settings arrive in `config.default.json` and `presets/`; your `config.json` keeps your values (compare the two files to pick up a new company board or key).

`cv/master.json` is a tracked file. If you changed it (you will have), `git pull` may stop with a conflict on it. Keep your version:

```bash
git stash                # put your changes aside
git pull
git stash pop            # bring them back; fix any conflict it reports, keeping your values
```

Or keep your own branch (`git switch -c mine`, commit your files there) and merge `main` into it after each `git fetch`.

**Updating from a version where `config.json` was tracked** (before `config.default.json` existed): that pull deletes your `config.json`. Copy it aside first and put it back afterwards:

```bash
cp config.json config.json.mine          # Windows: Copy-Item config.json config.json.mine
git pull
mv config.json.mine config.json          # Windows: Move-Item -Force config.json.mine config.json
```

If you forgot, the bot makes a new `config.json` from `config.default.json`; run `npm run bot -- setup` again, or get your old file back with `git show HEAD~1:config.json > config.json` right after the pull.

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

## If the update went wrong

Go back to the old code, then to the database from before the update (stop the dashboard first):

```bash
git log --oneline -5                 # find the commit you had before the pull
git switch --detach <that commit>
npm install
npm --prefix web install
npm run bot -- restore data/backups/job_bot-<date>.sql.gz --yes
```

`restore` first backs up the current (updated) database to `data/backups/job_bot-before-restore-<date>-<time>.sql.gz`, then loads the backup in one transaction. Use the file step 0 printed. Details and problems: [Restore a backup](troubleshooting.md#restore-a-backup). Once a fixed version is out, `git switch main` and update again; its migrations apply to the restored database on the next command.
