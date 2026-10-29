// Side panel "Apply helper": shows the prepared CV, cover letter and form answers for the job in the active tab,
// with Copy buttons. It only reads from the dashboard and the clipboard gets what the user copies; nothing is
// typed into, clicked on or submitted on the job site.
import { copyButton, h, link } from './dom.js';
import { lookupJob } from './lib/api.js';
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
  const verdict = j.ai_score != null ? `AI ${j.ai_score}${j.ai_verdict ? ` (${j.ai_verdict})` : ''} · keyword ${j.score}` : `score ${j.score}`;
  const answers = j.form_answers ?? [];
  return [
    h('h2', {}, `${j.company} — ${j.title}`),
    h('p', { className: 'meta' }, `Status: ${j.status} · ${verdict}`),
    j.ai_summary && h('p', {}, j.ai_summary),
    h('div', { className: 'actions' },
      link(j.dashboard_url, 'Open in dashboard'),
      // Applying is recorded on the dashboard, where the user also confirms it.
      j.status !== 'applied' && link(j.dashboard_url, 'Mark applied (in dashboard)')),
    h('h2', {}, 'CV'),
    j.cv_url
      ? h('p', {}, `Version: ${j.cv_version} · `, link(j.cv_url, 'Download PDF'))
      : h('p', { className: 'hint' }, 'No CV prepared yet. Use "Prepare" on the dashboard.'),
    h('h2', {}, 'Cover letter'),
    j.cover_letter
      ? h('div', { className: 'box' }, h('div', { className: 'row' }, h('span', { className: 'meta' }, 'Cover letter'), copyButton(j.cover_letter)),
        h('pre', {}, j.cover_letter))
      : h('p', { className: 'hint' }, 'No cover letter yet.'),
    h('h2', {}, 'Form answers'),
    answers.length
      ? answers.map((a) => h('div', { className: 'box' },
        h('div', { className: 'row' }, h('b', {}, a.question), copyButton(a.answer)),
        a.needs_input && h('p', { className: 'needs' }, `Check before using${a.note ? `: ${a.note}` : ''}`),
        h('pre', {}, a.answer)))
      : h('p', { className: 'hint' }, 'No answers drafted yet. Use "Draft answers" on the dashboard.'),
  ];
}

function renderUnknown() {
  const form = h('div');
  const read = h('button', { type: 'button' }, 'Read this page');
  read.addEventListener('click', async () => {
    // The panel has no activeTab grant, so ask once per site (from this click) to let it read the page.
    const granted = await chrome.permissions.request({ origins: [`${new URL(current.url).origin}/*`] }).catch(() => false);
    if (!granted) {
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
