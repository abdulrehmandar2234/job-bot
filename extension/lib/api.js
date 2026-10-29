// Calls to the local dashboard. `fetchImpl` is injectable so node:test can test this without a server.

export const DASHBOARD = 'http://localhost:3100';

export const OFFLINE = 'The job-bot dashboard is not running. Start it with `npm run web` in the job-bot folder, then try again.';

export const jobPageUrl = (id) => `${DASHBOARD}/jobs/${encodeURIComponent(id)}`;

async function call(fetchImpl, path, init) {
  let res;
  try {
    res = await fetchImpl(`${DASHBOARD}${path}`, init);
  } catch {
    return { ok: false, error: OFFLINE };
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, status: res.status, error: body?.error ?? `The dashboard answered ${res.status}.` };
  return { ok: true, body };
}

/** Sends one job to /api/import. Resolves to { ok, result } or { ok: false, error }. */
export async function sendJob(job, fetchImpl = fetch) {
  const r = await call(fetchImpl, '/api/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([job]),
  });
  if (!r.ok) return r;
  const result = r.body?.results?.[0];
  return result
    ? { ok: true, result }
    : { ok: false, error: 'The dashboard did not accept this job (it needs a title, a company and an http(s) URL).' };
}

/** Looks up the job for a tab URL. Resolves to { ok, job } (job is null when the bot does not know it) or { ok: false, error }. */
export async function lookupJob(url, fetchImpl = fetch) {
  const r = await call(fetchImpl, `/api/jobs/lookup?url=${encodeURIComponent(url)}`);
  if (!r.ok) return r;
  return { ok: true, job: r.body?.job ?? null };
}

const scoreText = (r) => (r.ai_score != null ? `AI score ${r.ai_score}, keyword score ${r.score}` : `score ${r.score}`);

/** One-line message for an import result. */
export function describeResult(r) {
  if (r.outcome === 'known') return `Already in job-bot (${r.status}, ${scoreText(r)}).`;
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
