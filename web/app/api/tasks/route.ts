import type { NextRequest } from 'next/server';
import { isActive, openTasks } from '@/lib/tasks';

// Polled every few seconds by TaskWatcher while a background task runs: just the ids of the active tasks
// (all of them, or one job's with ?job=<id>). Reading also expires tasks whose worker died.
export async function GET(req: NextRequest) {
  const job = req.nextUrl.searchParams.get('job') || undefined;
  const active = (await openTasks(job)).filter(isActive).map((t) => t.id);
  return Response.json({ active }, { headers: { 'cache-control': 'no-store' } });
}
