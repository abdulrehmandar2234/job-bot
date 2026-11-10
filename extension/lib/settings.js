// The dashboard address the extension talks to. Stored in chrome.storage.sync by the options page; the storage
// area is passed in, so node:test covers this with a fake. No chrome.* calls here.

export const DEFAULT_DASHBOARD = 'http://localhost:3100';

// The dashboard only ever runs on this computer (it refuses other hosts itself, web/proxy.ts).
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

const LOCAL_ONLY = 'The dashboard runs on this computer: use localhost or 127.0.0.1, for example http://localhost:3100.';

/**
 * Checks a dashboard address typed by the user: `http://localhost:3200`, `localhost:3200`, `127.0.0.1:3200` or a bare
 * port (`3200`). Only localhost and 127.0.0.1 are accepted, with no path, query or login. An empty value means
 * the default. Returns { ok: true, origin } or { ok: false, error }.
 */
export function parseDashboardOrigin(input) {
  let text = String(input ?? '').trim();
  if (!text) return { ok: true, origin: DEFAULT_DASHBOARD };
  if (/^\d{1,5}$/.test(text)) text = `localhost:${text}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let u;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, error: `"${String(input).trim()}" is not an address. ${LOCAL_ONLY}` };
  }
  if (!['http:', 'https:'].includes(u.protocol) || !LOCAL_HOSTS.has(u.hostname)) return { ok: false, error: LOCAL_ONLY };
  if (u.username || u.password || u.pathname !== '/' || u.search || u.hash)
    return { ok: false, error: 'Enter only the address and port, for example http://localhost:3100.' };
  return { ok: true, origin: u.origin };
}

/** The saved dashboard address (`area`: chrome.storage.sync), or the default when none or an invalid one is saved. */
export async function readDashboard(area) {
  try {
    const { dashboard } = (await area.get('dashboard')) ?? {};
    const parsed = parseDashboardOrigin(dashboard);
    return parsed.ok ? parsed.origin : DEFAULT_DASHBOARD;
  } catch {
    return DEFAULT_DASHBOARD;
  }
}

/** Checks and saves a dashboard address. Resolves to parseDashboardOrigin()'s result; nothing is saved on an error. */
export async function saveDashboard(area, input) {
  const parsed = parseDashboardOrigin(input);
  if (parsed.ok) await area.set({ dashboard: parsed.origin });
  return parsed;
}
