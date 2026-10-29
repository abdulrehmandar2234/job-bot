import type { NextRequest } from 'next/server';
import { findJobByUrl, isExtensionOrigin, isHttpUrl } from '@/lib/extension';

// The Chrome extension's "Apply helper" side panel asks here which job the open tab is, and what was prepared for it.
// Only the extension may read this (cover letters and answers are personal); web pages cannot forge Origin.

const cors = (origin: string | null) => ({
  'access-control-allow-origin': isExtensionOrigin(origin) ? origin : 'null',
  'access-control-allow-methods': 'GET',
});

export async function OPTIONS(req: NextRequest) {
  return new Response(null, { status: 204, headers: cors(req.headers.get('origin')) });
}

export async function GET(req: NextRequest) {
  const origin = req.headers.get('origin');
  if (!isExtensionOrigin(origin)) return Response.json({ error: 'Forbidden origin' }, { status: 403 });
  const url = req.nextUrl.searchParams.get('url');
  if (!isHttpUrl(url)) return Response.json({ error: 'url must be an http(s) URL' }, { status: 400, headers: cors(origin) });

  const j = await findJobByUrl(url);
  const base = req.nextUrl.origin;
  const job = j && {
    id: j.id,
    company: j.company,
    title: j.title,
    url: j.url,
    status: j.status,
    score: j.score,
    ai_score: j.ai_score,
    ai_verdict: j.ai_verdict,
    ai_summary: j.ai_summary,
    cv_version: j.cv_version,
    cv_url: j.cv_version ? `${base}/api/cv/${encodeURIComponent(j.cv_version)}?download` : null,
    cover_letter: j.cover_letter,
    form_answers: j.form_answers ?? [],
    dashboard_url: `${base}/jobs/${encodeURIComponent(j.id)}`,
  };
  return Response.json({ job }, { headers: { ...cors(origin), 'cache-control': 'no-store' } });
}
