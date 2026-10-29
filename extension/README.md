# job-bot Chrome extension

Sends the job you are looking at to your local job-bot, and shows what job-bot prepared for it (CV, cover letter, form answers) so you can copy it while you apply. It replaces the Bayt bookmarklet as the main way to add jobs from the browser. The bookmarklet still works.

## What it does

- **Send to job-bot** (toolbar button). When you click it, the popup reads the job from the open tab:
  - first from the page's schema.org `JobPosting` data (title, company, location, remote, description, date posted, url), which most job boards and career sites include;
  - else from the page title plus the text you selected (or the page's main text). Select the job description before clicking to send only that.

  You can fix the title, company and location, then press **Send to job-bot**. The dashboard runs it through `bot add` (same filters and scoring as fetched jobs) and the popup shows the result: added with its score, filtered with the reason, or already in job-bot.
- **Apply helper** (side panel, opened from the popup). For the job in the active tab it shows the status, the scores and AI verdict, a link to download the prepared CV, the cover letter and every drafted form answer, each with a **Copy** button. It follows you when you switch tabs. **Open in dashboard** and **Mark applied (in dashboard)** open the job's page on the dashboard, where you record the application. If the job is not in job-bot yet, the panel offers **Read this page** and the same send form (Chrome asks once per site to let the panel read pages there).

## What it does not do

- It never types into, clicks on or submits anything on a job site, and never logs in anywhere. It only reads the current page when you click, and shows text for you to copy. You fill in and submit every application yourself.
- It does not run in the background or read pages you do not click it on.
- It talks only to your local dashboard at `http://localhost:3100`. Nothing is sent anywhere else.

## Install (unpacked)

1. Start the dashboard: `npm run web` in the job-bot folder (it must be running at http://localhost:3100).
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose this `extension/` folder.
5. Pin the job-bot button to the toolbar (puzzle icon → pin).

After pulling changes, press the reload icon on the extension's card in `chrome://extensions`.

If the dashboard is not running, the popup and the side panel say so; start it and try again.

## How the dashboard trusts it

`/api/import` and `/api/jobs/lookup` accept only requests whose `Origin` is this extension: `chrome-extension://fmkmpckdcfhibobdiffankccildkcnij`. Web pages cannot forge the `Origin` header, so other sites cannot add jobs or read your letters. Other extensions you have installed are refused too.

The id is pinned by the public key in `manifest.json` (`"key"`): Chrome derives an unpacked extension's id from it, so every install gets the same id. The private key is not needed for loading unpacked and is not stored anywhere. If you replace the key, compute the new id (sha256 of the decoded key, first 32 hex digits mapped `0-f` → `a-p`, or read it on the extension's card in `chrome://extensions`) and set it for the dashboard in `web/.env.local`:

```
JOB_BOT_EXTENSION_ID=<new id>
```

Then restart the dashboard. The extension deliberately has no host permission for `localhost:3100`: with one, Chrome leaves out `Origin` on GET requests, and the lookup route would refuse them.

Permissions: `activeTab` + `scripting` (read the tab you clicked the button on), `tabs` (the side panel needs the active tab's url), `sidePanel`, `clipboardWrite` (Copy buttons). Reading pages from the side panel uses optional per-site permissions that Chrome asks you for.

## Files

- `manifest.json`: Manifest V3.
- `popup.html`, `popup.js`: the toolbar popup.
- `panel.html`, `panel.js`: the Apply helper side panel.
- `send.js`, `dom.js`, `style.css`: the shared send form and UI helpers.
- `lib/`: plain ES modules with no `chrome.*` calls, tested by `tests/extension.test.ts`:
  - `collect.js` reads the page (runs inside the tab, read-only),
  - `jobposting.js` turns JSON-LD or page text into a job,
  - `text.js` HTML to text and cleanup, `url.js` URL normalization and the hostname → source name,
  - `api.js` the calls to the dashboard and the result messages.
- `icons/`: PNG icons, drawn by `node extension/icons/make-icons.mjs`.
