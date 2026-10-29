// Side panel "Apply helper": shows the prepared CV, cover letter and form answers for the job in the active tab,
// with Copy buttons, and "Fill this form", which types them into the form's empty fields (lib/fill.js plans it,
// lib/page-fill.js applies it). Nothing is ever clicked on or submitted on the job site: the user checks the
// form and submits it.
import { copyButton, h, link } from './dom.js';
import { fetchCv, lookupJob } from './lib/api.js';
import { planFill } from './lib/fill.js';
import { applyFill, describeFields } from './lib/page-fill.js';
import { isHttpUrl } from './lib/url.js';
import { readTab, renderSendForm } from './send.js';

const main = document.getElementById('main');
let current = null; // the active tab
let seq = 0; // drops answers that arrive after the user switched tabs

async function refresh() {
  const n = ++seq;
  [current] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!isHttpUrl(current?.url)) {
    main.replaceChildren(h('p', {}, 'Open a job page to see what job-bot prepared for it.'));
    return;
  }
  const r = await lookupJob(current.url);
  if (n !== seq) return;
  if (!r.ok) main.replaceChildren(h('p', { className: 'box' }, r.error), h('button', { type: 'button', onclick: refresh }, 'Try again'));
  else if (r.job) main.replaceChildren(...renderJob(r.job).flat().filter(Boolean));
  else renderUnknown();
}

function renderJob(j) {
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
    fillSection(j),
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

function fillSection(j) {
  const status = h('div', { className: 'status' });
  const button = h('button', { type: 'button' }, 'Fill this form');
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.replaceChildren(h('p', {}, 'Filling…'));
    try {
      status.replaceChildren(...(await fillForm(j)));
    } catch (e) {
      status.replaceChildren(h('p', { className: 'needs' }, `Could not fill this page: ${e.message}`));
    } finally {
      button.disabled = false;
    }
  });
  return h(
    'div',
    { className: 'box' },
    h('div', { className: 'row' }, h('b', {}, 'Auto-fill'), button),
    h(
      'p',
      { className: 'hint' },
      'Types your details, the cover letter, drafted answers and the CV into empty fields. It never submits: check every field, then submit yourself.',
    ),
    status,
  );
}

/** Fills the form in the active tab, frame by frame. Returns the result lines for the panel. */
async function fillForm(j) {
  if (!(await askForSite(current.url))) return [h('p', {}, 'Without access to this site the panel cannot fill the form.')];
  const cv = j.cv_url ? await fetchCv(j.cv_url, j.cv_file_name) : null;
  const data = { profile: j.profile, cover_letter: j.cover_letter, answers: j.form_answers, cv };
  // Forms are often in an iframe (Greenhouse, Workday embeds). Frames on other sites need their own permission,
  // so fall back to the top frame when Chrome refuses some of them.
  const frames = await chrome.scripting
    .executeScript({ target: { tabId: current.id, allFrames: true }, func: describeFields })
    .catch(() => chrome.scripting.executeScript({ target: { tabId: current.id }, func: describeFields }));
  const filled = [];
  const skipped = [];
  for (const { frameId, result } of frames) {
    if (!result?.length) continue;
    const plan = planFill(result, data);
    skipped.push(...plan.skipped);
    if (!plan.fills.length) continue;
    const needsCv = plan.fills.some((f) => f.kind === 'file');
    await chrome.scripting.executeScript({
      target: { tabId: current.id, frameIds: [frameId] },
      func: applyFill,
      args: [plan.fills, needsCv ? cv : null],
    });
    filled.push(...plan.fills);
  }
  if (!filled.length) return [h('p', {}, 'No empty fields here that job-bot knows how to fill.')];
  const needInput = (j.form_answers ?? []).filter((a) => a.needs_input).length;
  return [
    h('p', {}, `Filled ${filled.length} fields (outlined in orange): ${filled.map((f) => f.label).join(', ')}.`),
    skipped.length > 0 && h('p', { className: 'needs' }, `Left for you: ${[...new Set(skipped)].join(', ')}.`),
    needInput > 0 && h('p', { className: 'needs' }, `${needInput} drafted answers need your input, so they were not filled.`),
    h('p', { className: 'hint' }, 'Check every field, then submit the form yourself.'),
  ].filter(Boolean);
}

function renderUnknown() {
  const form = h('div');
  const read = h('button', { type: 'button' }, 'Read this page');
  read.addEventListener('click', async () => {
    // The panel has no activeTab grant, so ask once per site (from this click) to let it read the page.
    if (!(await askForSite(current.url))) {
      form.replaceChildren(h('p', {}, 'Without access to this site the panel cannot read the job. Use the toolbar button instead.'));
      return;
    }
    try {
      renderSendForm(form, await readTab(current.id), () => setTimeout(refresh, 1500));
    } catch (e) {
      form.replaceChildren(h('p', {}, `Could not read this page: ${e.message}`));
    }
  });
  main.replaceChildren(h('p', {}, 'This job is not in job-bot yet.'), read, form);
}

document.getElementById('refresh').addEventListener('click', refresh);
chrome.tabs.onActivated.addListener(refresh);
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === current?.id && (info.url || info.status === 'complete')) refresh();
});
refresh();
