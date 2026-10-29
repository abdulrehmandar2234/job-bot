import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NextRequest } from 'next/server';
import { BOT_ROOT, runBot } from '@/lib/bot';

// Receives jobs collected in the browser on job sites that block direct requests (e.g. Bayt)
// and runs them through `bot add`, so the same filters and scoring apply.
// Only these origins may post here; everything else is rejected.
const ALLOWED = ['https://www.bayt.com', 'https://www.linkedin.com', 'https://www.gulftalent.com', 'https://www.naukrigulf.com'];

const cors = (origin: string | null) => ({
  'access-control-allow-origin': origin && ALLOWED.includes(origin) ? origin : 'null',
  'access-control-allow-methods': 'POST',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-private-network': 'true',
});

export async function OPTIONS(req: NextRequest) {
  return new Response(null, { status: 204, headers: cors(req.headers.get('origin')) });
}

type Incoming = { source?: string; company: string; title: string; location?: string; url: string; description?: string; posted_at?: string | null };

export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin');
  if (!origin || !ALLOWED.includes(origin)) return new Response('Forbidden origin', { status: 403 });

  const body = await req.json().catch(() => null);
  const jobs: Incoming[] = Array.isArray(body) ? body : [];
  const valid = jobs.filter((j) => typeof j?.title === 'string' && typeof j?.company === 'string'
    // `origin + '/'`, so look-alike hosts (www.bayt.com.evil.io) and userinfo (www.bayt.com@evil.io) don't pass.
    && typeof j?.url === 'string' && j.url.startsWith(`${origin}/`)).slice(0, 500)
    .map((j) => ({
      source: String(j.source ?? new URL(origin).hostname.replace(/^www\.|\.com$/g, '')).slice(0, 30),
      company: j.company.slice(0, 200), title: j.title.slice(0, 300), location: String(j.location ?? '').slice(0, 300),
      url: j.url, description: String(j.description ?? '').slice(0, 20000), posted_at: j.posted_at ?? null,
    }));
  if (!valid.length) return new Response(JSON.stringify({ added: 0 }), { headers: cors(origin) });

  const dir = join(BOT_ROOT, 'data', 'imports');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(file, JSON.stringify(valid));
  const out = await runBot(['add', '--file', file], 120_000);
  const matched = out.split('\n').filter((l) => /^\s*\d+\s/.test(l)).length;
  return new Response(JSON.stringify({ received: valid.length, matched, log: out.slice(0, 4000) }), {
    headers: { ...cors(origin), 'content-type': 'application/json' },
  });
}
