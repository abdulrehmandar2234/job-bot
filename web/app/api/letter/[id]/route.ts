import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { NextRequest } from 'next/server';
import { BOT_ROOT, runBot } from '@/lib/bot';
import { getJob } from '@/lib/db';

/** A safe file name for the download: "Cover_Letter_Acme_Corp.pdf". */
export const letterFileName = (company: string) =>
  `Cover_Letter_${
    company
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 60) || 'Job'
  }.pdf`;

/**
 * The job's cover letter as a PDF (`bot letter:pdf <id>`, in the CV's style), downloaded. It is printed on each
 * request, so it always matches the current letter.
 */
export async function GET(_req: NextRequest, ctx: RouteContext<'/api/letter/[id]'>) {
  const id = decodeURIComponent((await ctx.params).id);
  const job = await getJob(id);
  if (!job) return new Response('Job not found', { status: 404 });
  if (!job.cover_letter) return new Response('No cover letter yet: use "Write letter" first', { status: 404 });
  let out: string;
  try {
    out = await runBot(['letter:pdf', id], 60_000);
  } catch {
    return new Response('Could not print the cover letter (is Chrome at config.json chromePath?)', { status: 500 });
  }
  const file = out.match(/^PDF\s+:\s+(.+)$/m)?.[1]?.trim();
  // Only files the command writes, under applications/, are ever served.
  if (!file || !resolve(file).startsWith(join(BOT_ROOT, 'applications') + sep)) return new Response('No PDF was written', { status: 500 });
  const pdf = await readFile(file);
  return new Response(pdf, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${letterFileName(job.company)}"`,
      'cache-control': 'no-store',
    },
  });
}
