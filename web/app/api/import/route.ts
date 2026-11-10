import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NextRequest } from 'next/server';
import { botDataDir, runBot } from '@/lib/bot';
import { findJobByUrl, isExtensionOrigin, isHttpUrl, isImportToken } from '@/lib/extension';

// Receives jobs collected in the browser and runs them through `bot add`, so the same filters and scoring apply:
// - from the Bayt bookmarklet (and the job sites below): only urls on the posting site itself, and only with the
//   import token (header `x-import-token`, embedded in the collector that /api/bayt-script serves) — the origin
//   alone is not enough, since any third-party script running on these sites shares their origin;
// - from the job-bot Chrome extension (chrome-extension:// origin): any http(s) job url, no token needed.
// Every other origin is rejected. Browsers do not let web pages forge Origin, which is why this check works.
const ALLOWED = ['https://www.bayt.com', 'https://www.linkedin.com', 'https://www.gulftalent.com', 'https://www.naukrigulf.com'];

const allowed = (origin: string | null): origin is string => !!origin && (ALLOWED.includes(origin) || isExtensionOrigin(origin));

// No allow-origin header at all for a disallowed origin: the literal value "null" would match the "null" origin
// of sandboxed iframes and local files.
const cors = (origin: string | null) => ({
  ...(allowed(origin) ? { 'access-control-allow-origin': origin } : {}),
  'access-control-allow-methods': 'POST',
  'access-control-allow-headers': 'content-type, x-import-token',
  'access-control-allow-private-network': 'true',
});

export async function OPTIONS(req: NextRequest) {
  return new Response(null, { status: 204, headers: cors(req.headers.get('origin')) });
}

type Incoming = {
  source?: string;
  company: string;
  title: string;
  location?: string;
  url: string;
  description?: string;
  posted_at?: string | null;
};
type Valid = Required<Incoming>;

/** What happened to one job sent by the extension, for its popup. */
export type ImportResult = {
  url: string;
  outcome: 'added' | 'filtered' | 'known' | 'error';
  id?: string;
  status?: string;
  score?: number;
  ai_score?: number | null;
  filter_reason?: string | null;
};

/** A source slug as `bot add` stores it; anything else falls back to the origin's own name. */
const SOURCE = /^[a-z0-9-]{1,30}$/;

/**
 * `posted_at` as YYYY-MM-DD, or null. Collectors send whatever the site has (Bayt's datePosted can be "3 days ago"),
 * and one value Postgres cannot read as a date would fail `bot add` for the whole batch. Same rule as isoDate()
 * in extension/lib/jobposting.js, plus a check that the date exists (no 2026-02-30).
 */
function isoDate(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const day = v.slice(0, 10);
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(day) ? day : null;
}

const result = (url: string, outcome: ImportResult['outcome'], j?: Awaited<ReturnType<typeof findJobByUrl>>): ImportResult =>
  j ? { url, outcome, id: j.id, status: j.status, score: j.score, ai_score: j.ai_score, filter_reason: j.filter_reason } : { url, outcome };

export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin');
  if (!allowed(origin)) return new Response('Forbidden origin', { status: 403 });
  if (!isExtensionOrigin(origin) && !isImportToken(req.headers.get('x-import-token'))) {
    // JSON plus CORS headers, so the collector can tell the user (a stale tab, or a script not served by this dashboard).
    return Response.json(
      { error: 'Missing or wrong import token: load the collector through the dashboard bookmarklet and try again.' },
      { status: 403, headers: cors(origin) },
    );
  }
  try {
    return await importJobs(req, origin);
  } catch (e) {
    // A failed `bot add` (or database) still answers with JSON and CORS headers, so the collector can show why.
    // Only the bot's last stderr line (or the first message line) goes back; the full error is in the server log.
    console.error('POST /api/import failed:', e);
    const err = e as { stderr?: unknown; message?: unknown };
    const why =
      (typeof err.stderr === 'string' && err.stderr.trim().split('\n').at(-1)) ||
      (typeof err.message === 'string' && err.message.split('\n')[0]) ||
      String(e);
    return Response.json({ error: `Import failed: ${why}`.slice(0, 500) }, { status: 500, headers: cors(origin) });
  }
}

async function importJobs(req: NextRequest, origin: string) {
  const extension = isExtensionOrigin(origin);
  const fallbackSource = extension ? 'extension' : new URL(origin).hostname.replace(/^www\.|\.com$/g, '');

  const body = await req.json().catch(() => null);
  const jobs: Incoming[] = Array.isArray(body) ? body : [];
  const valid: Valid[] = jobs
    .filter(
      (j) =>
        typeof j?.title === 'string' &&
        typeof j?.company === 'string' &&
        // `origin + '/'`, so look-alike hosts (www.bayt.com.evil.io) and userinfo (www.bayt.com@evil.io) don't pass.
        (extension ? isHttpUrl(j?.url) : typeof j?.url === 'string' && j.url.startsWith(`${origin}/`)),
    )
    .slice(0, 500)
    .map((j) => ({
      source: typeof j.source === 'string' && SOURCE.test(j.source) ? j.source : fallbackSource,
      company: j.company.slice(0, 200),
      title: j.title.slice(0, 300),
      location: String(j.location ?? '').slice(0, 300),
      url: j.url,
      description: String(j.description ?? '').slice(0, 20000),
      posted_at: isoDate(j.posted_at),
    }));
  if (!valid.length) return new Response(JSON.stringify(extension ? { added: 0, results: [] } : { added: 0 }), { headers: cors(origin) });
  if (!extension) return Response.json(await add(valid), { headers: cors(origin) });

  // The extension shows per job whether it was added (with its score), filtered (with the reason) or already known.
  const results = new Map<Valid, ImportResult>();
  for (const j of valid) {
    const known = await findJobByUrl(j.url);
    if (known) results.set(j, result(j.url, 'known', known));
  }
  const fresh = valid.filter((j) => !results.has(j));
  const out = fresh.length ? await add(fresh) : { received: 0, matched: 0, log: '' };
  for (const j of fresh) {
    const saved = await findJobByUrl(j.url);
    results.set(j, result(j.url, !saved ? 'error' : saved.status === 'filtered' ? 'filtered' : 'added', saved ?? undefined));
  }
  return Response.json({ ...out, received: valid.length, results: valid.map((j) => results.get(j)) }, { headers: cors(origin) });
}

/** A failed import's file is kept this long for debugging, then prune() removes it. */
const KEEP_FAILED_MS = 14 * 86_400_000;

/**
 * Writes the jobs to an import file and runs `bot add --file` on it. The file is deleted once `bot add`
 * succeeded; a failed run keeps it for debugging, and prune() clears such leftovers after two weeks.
 */
async function add(jobs: Valid[]) {
  const dir = join(botDataDir(), 'imports');
  await mkdir(dir, { recursive: true });
  await prune(dir).catch(() => {}); // best effort: a prune problem must not fail the import
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(file, JSON.stringify(jobs));
  const out = await runBot(['add', '--file', file], 120_000);
  await rm(file, { force: true }).catch(() => {});
  const matched = out.split('\n').filter((l) => /^\s*\d+\s/.test(l)).length;
  return { received: jobs.length, matched, log: out.slice(0, 4000) };
}

/** Removes import files older than KEEP_FAILED_MS (leftovers of failed `bot add` runs). */
async function prune(dir: string) {
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = join(dir, name);
    const old = await stat(file)
      .then((s) => Date.now() - s.mtimeMs > KEEP_FAILED_MS)
      .catch(() => false);
    if (old) await rm(file, { force: true }).catch(() => {});
  }
}
