// Side panel "Apply helper": shows the prepared CV, cover letter and form answers for the job in the active tab,
// with Copy buttons, and "Fill this form", which types them into the form's empty fields (lib/fill.js plans it,
// lib/page-fill.js applies it). Nothing is ever clicked on or submitted on the job site: the user checks the
// form and submits it.
// A tab keeps its job while it moves through the steps of the application form (lib/tab-memory.js, in
// chrome.storage.session), together with the last fill result. A page with no known job gets "Fill profile + CV
// only". The dashboard address comes from the options page (lib/settings.js).
import { copyButton, h, link } from './dom.js';
import { fetchCv, lookupJob, useDashboard } from './lib/api.js';
import { fillData, fillSummary, planFrameFills } from './lib/fill.js';
import { applyFill, describeFields, listFrameUrls } from './lib/page-fill.js';
import { readDashboard } from './lib/settings.js';
import { forgetTab, recallJob, rememberJob, saveFillResult } from './lib/tab-memory.js';
import { frameOrigins, isHttpUrl, sameTab } from './lib/url.js';
import { readTab, renderSendForm } from './send.js';

const main = document.getElementById('main');
const session = chrome.storage.session;
let current = null; // the active tab
let seq = 0; // drops answers that arrive after the user switched tabs

useDashboard(await readDashboard(chrome.storage.sync));

const optionsButton = () =>
  h('button', { type: 'button', className: 'secondary', onclick: () => chrome.runtime.openOptionsPage() }, 'Extension options');

async function refresh() {
  const n = ++seq;
  [current] = await chrome.tabs.query({ active: true, currentWindow: true });
  // Drop the previous job at once, so its Fill button cannot be used on the new tab while the lookup runs.
  main.replaceChildren(h('p', { className: 'hint' }, 'Loading…'));
  if (!isHttpUrl(current?.url)) {
    main.replaceChildren(h('p', {}, 'Open a job page to see what Talaash prepared for it.'));
    return;
  }
  const tab = { id: current.id, url: current.url };
  const r = await lookupJob(tab.url);
  if (n !== seq) return;
  if (!r.ok) {
    main.replaceChildren(
      h('p', { className: 'box' }, r.error),
      h('div', { className: 'actions' }, h('button', { type: 'button', onclick: refresh }, 'Try again'), optionsButton()),
    );
    return;
  }
  // The job found here is remembered for the tab; on a later step of its form (another URL) it is recalled.
  const entry = r.job ? await rememberJob(session, tab.id, tab.url, r.job) : await recallJob(session, tab.id, tab.url);
  if (n !== seq) return;
  if (!entry) {
    renderUnknown(r.basics, tab);
    return;
  }
  main.replaceChildren(
    ...[
      !r.job && h('p', { className: 'hint' }, 'The job this tab is applying for (found on an earlier page of this application).'),
      ...renderJob(entry.job, tab, entry.result),
    ]
      .flat()
      .filter(Boolean),
  );
}

function renderJob(j, tab, lastResult) {
  const verdict =
    j.ai_score != null ? `AI ${j.ai_score}${j.ai_verdict ? ` (${j.ai_verdict})` : ''} · keyword ${j.score}` : `score ${j.score}`;
  const answers = j.form_answers ?? [];
  return [
    h('h2', {}, `${j.company} — ${j.title}`),
    h('p', { className: 'meta' }, `Status: ${j.status} · ${verdict}`),
    j.ai_summary && h('p', {}, j.ai_summary),
    h(
      'div',
      { className: 'actions' },
      link(j.dashboard_url, 'Open in dashboard'),
      // Applying is recorded on the dashboard, where the user also confirms it.
      j.status !== 'applied' && link(j.dashboard_url, 'Mark applied (in dashboard)'),
    ),
    fillSection(j, tab, { lastResult }),
    h('h2', {}, 'CV'),
    j.cv_url
      ? h('p', {}, `Version: ${j.cv_version} · `, link(j.cv_url, 'Download PDF'))
      : h('p', { className: 'hint' }, 'No CV prepared yet. Use "Prepare" on the dashboard.'),
    h('h2', {}, 'Cover letter'),
    j.cover_letter
      ? h(
          'div',
          { className: 'box' },
          h('div', { className: 'row' }, h('span', { className: 'meta' }, 'Cover letter'), copyButton(j.cover_letter)),
          h('pre', {}, j.cover_letter),
        )
      : h('p', { className: 'hint' }, 'No cover letter yet.'),
    h('h2', {}, 'Form answers'),
    answers.length
      ? answers.map((a) =>
          h(
            'div',
            { className: 'box' },
            h('div', { className: 'row' }, h('b', {}, a.question), copyButton(a.answer)),
            a.needs_input && h('p', { className: 'needs' }, `Check before using${a.note ? `: ${a.note}` : ''}`),
            h('pre', {}, a.answer),
          ),
        )
      : h('p', { className: 'hint' }, 'No answers drafted yet. Use "Draft answers" on the dashboard.'),
  ];
}

/** Asks once per site (from the user's click) to let the panel work in the page. */
const askForSite = (url) => chrome.permissions.request({ origins: [`${new URL(url).origin}/*`] }).catch(() => false);

const summaryNodes = (result) => fillSummary(result).map((l) => h('p', { className: l.kind === 'plain' ? '' : l.kind }, l.text));

/**
 * The Auto-fill box. `profileOnly`: a page with no known job, where only the profile and the original CV are
 * filled. `lastResult`: the last fill result kept for this tab, shown again after a step of the form changed the URL.
 */
function fillSection(j, tab, { profileOnly = false, lastResult = null } = {}) {
  const status = h('div', { className: 'status' }, ...(lastResult ? summaryNodes(lastResult) : []));
  const button = h('button', { type: 'button' }, profileOnly ? 'Fill profile + CV only' : 'Fill this form');
  const run = async () => {
    button.disabled = true;
    status.replaceChildren(h('p', {}, 'Filling…'));
    try {
      const out = await fillForm(j, tab, run, profileOnly);
      if (out.result) {
        status.replaceChildren(...summaryNodes(out.result));
        if (!profileOnly) await saveFillResult(session, tab.id, j.id, out.result);
      } else status.replaceChildren(...out.nodes);
    } catch (e) {
      status.replaceChildren(h('p', { className: 'needs' }, `Could not fill this page: ${e.message}`));
    } finally {
      button.disabled = false;
    }
  };
  button.addEventListener('click', run);
  return h(
    'div',
    { className: 'box' },
    h('div', { className: 'row' }, h('b', {}, 'Auto-fill'), button),
    h(
      'p',
      { className: 'hint' },
      profileOnly
        ? 'Types your name, contact details and your original CV into empty fields. No cover letter or answers: this page is not a job in Talaash. It never submits: check every field, then submit yourself.'
        : 'Types your details, the cover letter, drafted answers and the CV into empty fields. It never submits: check every field, then submit yourself.',
    ),
    status,
  );
}

/**
 * Fills the form in the job's tab, frame by frame. Resolves to { result } ({ filled, skipped, needInput }, see
 * lib/fill.js fillSummary) or { nodes } (a message, or the "Allow" button shown when the form sits in an iframe from
 * another site; `retry` runs the fill again from it).
 */
async function fillForm(j, tab, retry, profileOnly) {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!sameTab(tab, active))
    return { nodes: [h('p', { className: 'needs' }, 'The tab changed since this job was shown. Press Refresh, then fill.')] };
  if (!(await askForSite(tab.url))) return { nodes: [h('p', {}, 'Without access to this site the panel cannot fill the form.')] };
  // A form embedded from another site needs access to that site too. Chrome only asks from a click, so a missing
  // one gets its own "Allow" button (a fresh click) instead of failing silently.
  const [top] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: listFrameUrls });
  const missing = [];
  for (const origin of frameOrigins(tab.url, top?.result)) {
    if (!(await chrome.permissions.contains({ origins: [origin] }))) missing.push(origin);
  }
  if (missing.length) {
    const sites = missing.map((o) => o.replace(/\/\*$/, '')).join(', ');
    const allow = h('button', { type: 'button' }, `Allow ${sites} and fill`);
    allow.addEventListener('click', async () => {
      if (await chrome.permissions.request({ origins: missing }).catch(() => false)) retry();
    });
    return { nodes: [h('p', {}, `Part of this form comes from ${sites}. Allow Talaash there too, so it can fill the whole form.`), allow] };
  }
  // The CV PDF is downloaded only when a form has a CV field; planning needs just its name.
  const data = fillData(j, { profileOnly });
  let cv = null;
  // Forms are often in an iframe (Greenhouse, Workday embeds). If Chrome still refuses a frame, fill the top one.
  const frames = await chrome.scripting
    .executeScript({ target: { tabId: tab.id, allFrames: true }, func: describeFields })
    .catch(() => chrome.scripting.executeScript({ target: { tabId: tab.id }, func: describeFields }));
  // All frames are planned in one pass, so a drafted answer is typed into one field on the page, not once per frame.
  const plans = planFrameFills(
    frames.map((f) => f.result ?? []),
    data,
  );
  const filled = [];
  const skipped = [];
  for (const [i, { frameId }] of frames.entries()) {
    const plan = plans[i];
    skipped.push(...plan.skipped);
    if (plan.fills.some((f) => f.kind === 'file')) cv ??= await fetchCv(j.cv_url, j.cv_file_name);
    const fills = cv ? plan.fills : plan.fills.filter((f) => f.kind !== 'file');
    if (!fills.length) continue;
    await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [frameId] }, func: applyFill, args: [fills, cv] });
    filled.push(...fills.map((f) => f.label));
  }
  const needInput = data.answers.filter((a) => a.needs_input).length;
  return { result: { filled, skipped: [...new Set(skipped)], needInput } };
}

/** A page with no known job: send it to Talaash, or fill just the profile and the original CV. */
function renderUnknown(basics, tab) {
  const form = h('div');
  const read = h('button', { type: 'button' }, 'Read this page');
  read.addEventListener('click', async () => {
    // The panel has no activeTab grant, so ask once per site (from this click) to let it read the page.
    if (!(await askForSite(tab.url))) {
      form.replaceChildren(h('p', {}, 'Without access to this site the panel cannot read the job. Use the toolbar button instead.'));
      return;
    }
    try {
      renderSendForm(form, await readTab(tab.id), () => setTimeout(refresh, 1500));
    } catch (e) {
      form.replaceChildren(h('p', {}, `Could not read this page: ${e.message}`));
    }
  });
  const profile = basics?.profile ?? {};
  const canFill = Object.values(profile).some(Boolean) || Boolean(basics?.cv_url);
  main.replaceChildren(
    ...[
      h('p', {}, 'This job is not in Talaash yet.'),
      read,
      form,
      canFill && fillSection({ profile, cv_url: basics.cv_url, cv_file_name: basics.cv_file_name }, tab, { profileOnly: true }),
    ].filter(Boolean),
  );
}

document.getElementById('refresh').addEventListener('click', refresh);
chrome.tabs.onActivated.addListener(refresh);
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === current?.id && (info.url || info.status === 'complete')) refresh();
});
chrome.tabs.onRemoved.addListener((tabId) => forgetTab(session, tabId));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes.dashboard) return;
  useDashboard(changes.dashboard.newValue);
  refresh();
});
refresh();
