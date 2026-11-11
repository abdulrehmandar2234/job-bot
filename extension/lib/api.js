// Calls to the local dashboard. `fetchImpl` is injectable so node:test can test this without a server.
// The dashboard address comes from the options page (lib/settings.js); popup and panel set it with useDashboard().
import { DEFAULT_DASHBOARD, parseDashboardOrigin } from './settings.js';

let dashboard = DEFAULT_DASHBOARD;

/** Sets the dashboard address for the calls below (an invalid one falls back to the default). */
export function useDashboard(origin) {
  const parsed = parseDashboardOrigin(origin);
  dashboard = parsed.ok ? parsed.origin : DEFAULT_DASHBOARD;
}

/** The dashboard address in use. */
export const dashboardOrigin = () => dashboard;

/** The message for a dashboard that does not answer at `origin`. */
export const offlineMessage = (origin = dashboard) =>
  `The Talaash dashboard is not running at ${origin}. Start it with \`npm run web\` in the Talaash folder (or check the dashboard address in the extension options), then try again.`;

export const OFFLINE = offlineMessage(DEFAULT_DASHBOARD);

/** The message for an app at `origin` that answers but is not Talaash (another app on that port). */
export const wrongAppMessage = (origin = dashboard) =>
  `Something else is answering on ${origin} — check the dashboard port in the extension options.`;

export const jobPageUrl = (id) => `${dashboard}/jobs/${encodeURIComponent(id)}`;

async function call(fetchImpl, path, init) {
  let res;
  try {
    res = await fetchImpl(`${dashboard}${path}`, init);
  } catch {
    return { ok: false, error: offlineMessage() };
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, status: res.status, body, error: body?.error ?? `The dashboard answered ${res.status}.` };
  return { ok: true, body };
}

/** Sends one job to /api/import. Resolves to { ok, result } or { ok: false, error }. */
export async function sendJob(job, fetchImpl = fetch) {
  const r = await call(fetchImpl, '/api/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([job]),
  });
  if (!r.ok && !('status' in r)) return r; // not running
  // Talaash's /api/import never answers 404: that comes from another app on the dashboard's port.
  if (r.status === 404) return { ok: false, status: 404, error: wrongAppMessage() };
  if (!r.ok) return { ok: false, status: r.status, error: r.error };
  const result = r.body?.results?.[0];
  return result
    ? { ok: true, result }
    : { ok: false, error: 'The dashboard did not accept this job (it needs a title, a company and an http(s) URL).' };
}

/**
 * Looks up the job for a tab URL. Resolves to { ok, job, basics } (job is null when the bot does not know it; basics
 * then holds { profile, cv_url, cv_file_name } for "Fill profile + CV only") or { ok: false, error }. An answer
 * without Talaash's `app` marker comes from another app on the dashboard's port.
 */
export async function lookupJob(url, fetchImpl = fetch) {
  const r = await call(fetchImpl, `/api/jobs/lookup?url=${encodeURIComponent(url)}`);
  if (!r.ok && !('status' in r)) return r; // not running
  if (r.body?.app !== 'job-bot') return { ok: false, error: wrongAppMessage() };
  if (!r.ok) return { ok: false, status: r.status, error: r.error };
  return { ok: true, job: r.body.job ?? null, basics: r.body.basics ?? null };
}

const scoreText = (r) => (r.ai_score != null ? `AI score ${r.ai_score}, keyword score ${r.score}` : `score ${r.score}`);

/** One-line message for an import result. */
export function describeResult(r) {
  if (r.outcome === 'known') return `Already in Talaash (${r.status}, ${scoreText(r)}).`;
  if (r.outcome === 'filtered') return `Added, but filtered out: ${r.filter_reason ?? 'no reason given'}.`;
  if (r.outcome === 'added') return `Added with ${scoreText(r)}.`;
  return 'The bot could not save this job. Check the dashboard log.';
}

/** Empty when a job can be sent, else what is missing. */
export function missingFields(job) {
  return ['title', 'company', 'url'].filter((k) => !String(job?.[k] ?? '').trim());
}

/**
 * Downloads the prepared CV PDF for a form's CV field. Resolves to { name, type, base64 } or null when it cannot
 * be read (the panel then fills everything else).
 */
export async function fetchCv(url, name = 'CV.pdf', fetchImpl = fetch) {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { name, type: 'application/pdf', base64: btoa(bin) };
  } catch {
    return null;
  }
}
