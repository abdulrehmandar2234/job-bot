// "Send to job-bot", shared by the popup and the side panel: reads the open job page once (on the user's click)
// and lets the user check company, title and location before sending. It never changes the job page.
import { h, link } from './dom.js';
import { describeResult, jobPageUrl, missingFields, sendJob } from './lib/api.js';
import { collectPage } from './lib/collect.js';
import { jobFromPage } from './lib/jobposting.js';

/** Reads the page in a tab (read-only) and returns the job found on it. */
export async function readTab(tabId) {
  const [frame] = await chrome.scripting.executeScript({ target: { tabId }, func: collectPage });
  if (!frame?.result) throw new Error('Could not read this page.');
  return jobFromPage(frame.result);
}

/** Renders the editable job and the Send button into `root`. `onSent(result)` runs after a successful send. */
export function renderSendForm(root, { method, job }, onSent) {
  const field = (name, label) => h('label', {}, label, h('input', { name, value: job[name] ?? '' }));
  const status = h('p', { className: 'status' });
  const form = h('form', {},
    h('p', { className: 'hint' }, method === 'jsonld'
      ? 'Read from the job posting data on this page.'
      : 'No job posting data on this page: check the fields. Select the job text before opening this to send only that.'),
    field('title', 'Title'), field('company', 'Company'), field('location', 'Location'),
    h('p', { className: 'hint' }, `Source: ${job.source} · ${job.description.length.toLocaleString('en')} characters of description`),
    h('button', { type: 'submit' }, 'Send to job-bot'),
    status);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const edited = { ...job, title: String(data.get('title')).trim(), company: String(data.get('company')).trim(), location: String(data.get('location')).trim() };
    const missing = missingFields(edited);
    if (missing.length) {
      status.textContent = `Please fill in: ${missing.join(', ')}.`;
      return;
    }
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    status.textContent = 'Sending… (scoring can take a few seconds)';
    const r = await sendJob(edited);
    button.disabled = false;
    if (!r.ok) {
      status.textContent = r.error;
      return;
    }
    status.replaceChildren(describeResult(r.result), ' ', r.result.id ? link(jobPageUrl(r.result.id), 'Open in dashboard') : '');
    if (r.result.outcome !== 'error') onSent?.(r.result);
  });
  root.replaceChildren(form);
}
