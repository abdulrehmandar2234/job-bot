// Remembers which job a tab is applying for, so a multi-step application form keeps its job (and the last
// "Filled N / Left for you" result) while its URL changes from step to step. Kept in chrome.storage.session
// (memory only, gone when the browser closes); the storage area is passed in, so node:test covers this with a fake.
// No chrome.* calls here.
//
// The memory holds while the tab stays inside the job's scope: the same host, a path under the posting's path
// (the application step taken off, lib/url.js postingUrl), and no other job id parameter. Same host alone is not
// enough: jobs.lever.co and jobs.ashbyhq.com host every company's jobs, and another job there must never get this
// job's letter and answers.
import { isHttpUrl, JOB_ID_PARAMS, postingUrl } from './url.js';

const key = (tabId) => `tab:${tabId}`;

const jobIds = (u) =>
  [...u.searchParams]
    .map(([k, v]) => [k.toLowerCase(), v])
    .filter(([k, v]) => v !== '' && JOB_ID_PARAMS.includes(k))
    .map(([k, v]) => `${k}=${v}`)
    .sort();

/** The scope of a job found at `url`: { host, path, ids }, or null for a URL that is not http(s). */
export function jobScope(url) {
  if (!isHttpUrl(url)) return null;
  const u = new URL(postingUrl(url) ?? url);
  return { host: u.host.toLowerCase(), path: u.pathname.replace(/\/+$/, ''), ids: jobIds(u) };
}

/** Whether `url` is still inside `scope`: same host, a path at or under the scope's, no other job id. */
export function inScope(scope, url) {
  if (!scope || !isHttpUrl(url)) return false;
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/, '');
  if (u.host.toLowerCase() !== scope.host) return false;
  if (path !== scope.path && !path.startsWith(`${scope.path}/`)) return false;
  const ids = jobIds(u);
  return ids.length === 0 || ids.join('&') === scope.ids.join('&');
}

async function read(area, tabId) {
  try {
    return (await area.get(key(tabId)))?.[key(tabId)] ?? null;
  } catch {
    return null;
  }
}

/**
 * Remembers that tab `tabId` shows `job` at `url`. When the tab already remembers the same job and `url` is in its
 * scope (the next step of the same form), the scope and the last fill result are kept. Resolves to the entry
 * ({ job, scope, result }).
 */
export async function rememberJob(area, tabId, url, job) {
  const old = await read(area, tabId);
  const entry = old && old.job?.id === job.id && inScope(old.scope, url) ? { ...old, job } : { job, scope: jobScope(url), result: null };
  await area.set({ [key(tabId)]: entry });
  return entry;
}

/** The job tab `tabId` remembers, if `url` is still in its scope; otherwise forgets it and resolves to null. */
export async function recallJob(area, tabId, url) {
  const entry = await read(area, tabId);
  if (!entry) return null;
  if (inScope(entry.scope, url)) return entry;
  await forgetTab(area, tabId);
  return null;
}

/** Keeps the last fill result ({ filled, skipped, needInput }) for the job tab `tabId` remembers. */
export async function saveFillResult(area, tabId, jobId, result) {
  const entry = await read(area, tabId);
  if (!entry || entry.job?.id !== jobId) return;
  await area.set({ [key(tabId)]: { ...entry, result } });
}

/** Forgets the tab (it closed, or left the job's scope). */
export async function forgetTab(area, tabId) {
  try {
    await area.remove(key(tabId));
  } catch {
    // Nothing to forget.
  }
}
