import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { NextRequest } from 'next/server';
import { botDataDir, runBot } from '@/lib/bot';
import { isTemplate } from '@/lib/cv-templates';

const PAGE = 'html { background: #fff; color-scheme: light; } body { max-width: 210mm; margin: 0 auto !important; }';

/**
 * The master CV in one template, to see a design before choosing it (`bot cv:preview <template>`): inline HTML, or
 * with `?pdf` an inline PDF printed by Chrome. Only names from the template list reach the bot.
 */
export async function GET(req: NextRequest, ctx: RouteContext<'/api/cv/preview/[template]'>) {
  const { template } = await ctx.params;
  if (!isTemplate(template)) return new Response('Unknown CV template', { status: 400 });
  const pdf = req.nextUrl.searchParams.has('pdf');
  let out: string;
  try {
    out = await runBot(['cv:preview', template, ...(pdf ? ['--pdf'] : [])], 60_000);
  } catch {
    return new Response(`Could not render the preview${pdf ? ' (is Chrome at config.json chromePath?)' : ''}`, { status: 500 });
  }
  if (!pdf)
    // White and A4 wide, as on paper (a browser in dark mode would otherwise show the CV's dark text on dark).
    return new Response(out.replace('</head>', `<style>${PAGE}</style></head>`), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // The page is the CV only: no scripts, no requests, inline styles.
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      },
    });
  const file = out.match(/^PDF\s+:\s+(.+)$/m)?.[1]?.trim();
  // Only the file the command writes, under previews/ in the data folder, is ever served.
  if (!file || !resolve(file).startsWith(join(resolve(botDataDir()), 'previews') + sep))
    return new Response('No PDF was written', { status: 500 });
  return new Response(await readFile(file), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="cv-preview-${template}.pdf"`,
      'cache-control': 'no-store',
    },
  });
}
