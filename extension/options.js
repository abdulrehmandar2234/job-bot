// Options page: the dashboard address (localhost or 127.0.0.1 only), saved in chrome.storage.sync. The popup and
// the side panel read it on open (lib/settings.js); the panel also follows a change at once.
import { dashboardOrigin, lookupJob, useDashboard } from './lib/api.js';
import { parseDashboardOrigin, readDashboard, saveDashboard } from './lib/settings.js';

const input = document.getElementById('dashboard');
const status = document.getElementById('status');

input.value = await readDashboard(chrome.storage.sync);

document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const saved = await saveDashboard(chrome.storage.sync, input.value);
  if (!saved.ok) {
    status.textContent = saved.error;
    return;
  }
  input.value = saved.origin;
  useDashboard(saved.origin);
  status.textContent = `Saved: ${saved.origin}.`;
});

// Asks the dashboard about a made-up page: job-bot answers with its marker, another app does not.
document.getElementById('check').addEventListener('click', async () => {
  const parsed = parseDashboardOrigin(input.value);
  if (!parsed.ok) {
    status.textContent = parsed.error;
    return;
  }
  useDashboard(parsed.origin);
  status.textContent = 'Checking…';
  const r = await lookupJob('https://example.com/job-bot-connection-check');
  status.textContent = r.ok ? `job-bot answers at ${dashboardOrigin()}.` : r.error;
});
