import { existsSync } from 'node:fs';
import type { NextRequest } from 'next/server';
import { cvFileName, cvPath } from '@/lib/cv-templates';
import { fillProfile, findJobByUrl, isExtensionOrigin, isHttpUrl } from '@/lib/extension';

// The Chrome extension's "Apply helper" side panel asks here which job the open tab is, and what was prepared for it.
// Only the extension may read this (cover letters and answers are personal); web pages cannot forge Origin.
// Every JSON answer carries `app: 'job-bot'`, so the extension can tell this dashboard from another app that
// happens to answer on the port it was given.

const APP = { app: 'job-bot' } as const;

const cors = (origin: string | null) => ({
  'access-control-allow-origin': isExtensionOrigin(origin) ? origin : 'null',
  'access-control-allow-methods': 'GET',
});

export async function OPTIONS(req: NextRequest) {
  return new Response(null, { status: 204, headers: cors(req.headers.get('origin')) });
}

export async function GET(req: NextRequest) {
  const origin = req.headers.get('origin');
  if (!isExtensionOrigin(origin)) return Response.json({ ...APP, error: 'Forbidden origin' }, { status: 403 });
  const url = req.nextUrl.searchParams.get('url');
  if (!isHttpUrl(url)) return Response.json({ ...APP, error: 'url must be an http(s) URL' }, { status: 400, headers: cors(origin) });

  const j = await findJobByUrl(url);
  const base = req.nextUrl.origin;
  const headers = { ...cors(origin), 'cache-control': 'no-store' };
  if (!j) {
    // A page with no known job may still get the profile and the original CV ("Fill profile + CV only").
    const basics = {
      profile: fillProfile(),
      cv_url: existsSync(cvPath('default')) ? `${base}/api/cv/default?download` : null,
      cv_file_name: cvFileName(),
    };
    return Response.json({ ...APP, job: null, basics }, { headers });
  }
  const job = {
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
    cv_file_name: cvFileName(),
    cover_letter: j.cover_letter,
    form_answers: j.form_answers ?? [],
    dashboard_url: `${base}/jobs/${encodeURIComponent(j.id)}`,
    profile: fillProfile(), // for "Fill this form": typed only into empty fields, never submitted
  };
  return Response.json({ ...APP, job }, { headers });
}
