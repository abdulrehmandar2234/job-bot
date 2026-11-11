// Toolbar popup: reads the job on the active tab (the user's click on the toolbar button is what starts it)
// and sends it to the dashboard. It never fills in, clicks or submits anything on the job site.
import { h, link } from './dom.js';
import { jobPageUrl, lookupJob, useDashboard } from './lib/api.js';
import { readDashboard } from './lib/settings.js';
import { isHttpUrl } from './lib/url.js';
import { readTab, renderSendForm } from './send.js';

const main = document.getElementById('main');
const known = document.getElementById('known');
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

// The side panel must be opened straight from the click, before any await.
document.getElementById('helper').addEventListener('click', () => {
  chrome.sidePanel.open({ windowId: tab.windowId });
  window.close();
});

useDashboard(await readDashboard(chrome.storage.sync));

if (!isHttpUrl(tab?.url)) {
  main.replaceChildren(h('p', {}, 'Open a job page first, then click the Talaash button again.'));
} else {
  lookupJob(tab.url).then((r) => {
    if (r.ok && r.job) {
      known.replaceChildren(
        h(
          'p',
          { className: 'box' },
          `Already in Talaash: ${r.job.company} — ${r.job.title} (${r.job.status}). `,
          link(jobPageUrl(r.job.id), 'Open in dashboard'),
        ),
      );
    } else if (!r.ok) {
      const options = h('button', { type: 'button', className: 'secondary' }, 'Extension options');
      options.addEventListener('click', () => chrome.runtime.openOptionsPage());
      known.replaceChildren(h('p', { className: 'box' }, r.error), options);
    }
  });
  readTab(tab.id)
    .then((found) => renderSendForm(main, found))
    .catch((e) => main.replaceChildren(h('p', {}, `Could not read this page: ${e.message}`)));
}
