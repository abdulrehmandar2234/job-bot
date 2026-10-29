import { readFile } from 'node:fs/promises';
import type { NextRequest } from 'next/server';
import { cvFileName, cvPath } from '@/lib/bot';
import { isExtensionOrigin } from '@/lib/extension';

/**
 * Serves a CV PDF so it can be opened, downloaded and uploaded to an application form. The job-bot extension may
 * also read it (CORS for its origin only), to attach it to a form's CV field.
 */
export async function GET(req: NextRequest, ctx: RouteContext<'/api/cv/[version]'>) {
  const { version } = await ctx.params;
  const origin = req.headers.get('origin');
  if (!/^[a-z0-9-]+$/.test(version)) return new Response('Bad version', { status: 400 });
  try {
    const pdf = await readFile(cvPath(version));
    const disposition = req.nextUrl.searchParams.has('download') ? 'attachment' : 'inline';
    return new Response(pdf, {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `${disposition}; filename="${cvFileName()}"`,
        'cache-control': 'no-store',
        ...(isExtensionOrigin(origin) && { 'access-control-allow-origin': origin, vary: 'Origin' }),
      },
    });
  } catch {
    return new Response('CV not found', { status: 404 });
  }
}
