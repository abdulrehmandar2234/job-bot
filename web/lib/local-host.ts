// The dashboard is for this Mac only: `npm run web` binds 127.0.0.1, and proxy.ts refuses any other Host, so a
// web page that rebinds its own domain to 127.0.0.1 (DNS rebinding) cannot read cover letters or run actions.

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Whether a Host header names this machine (any port). */
export function isLocalHost(host: string | null): boolean {
  if (!host) return false;
  const name = host.toLowerCase().replace(/:\d+$/, '');
  return LOCAL.has(name);
}
