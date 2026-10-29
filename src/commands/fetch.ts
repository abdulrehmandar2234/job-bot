import { config } from '../config.ts';
import { pool, type Job } from '../db.ts';
import { fetchCompany } from '../sources/index.ts';
import { BOARDS } from '../sources/boards.ts';
import { linkedin } from '../sources/linkedin.ts';
import type { RawJob } from '../types.ts';
import { save, type Flags } from './shared.ts';

const waitingCount = async () => (await pool.query<{ n: number }>(`SELECT count(*)::int n FROM jobs WHERE status = 'new'`)).rows[0].n;

/** fetch [--company name]: pulls jobs from every source, then filters and scores them. */
export async function fetch(_args: string[], flags: Flags) {
  const only = flags.company?.toLowerCase();
  const { rows: [run] } = await pool.query<{ id: number }>('INSERT INTO fetch_runs DEFAULT VALUES RETURNING id');
  const before = await waitingCount();
  let added = 0, total = 0;
  const errors: { company: string; error: string }[] = [];
  const sources: { name: string; load: () => Promise<RawJob[]> }[] = [
    ...config.companies.map((c) => ({ name: c.name, load: () => fetchCompany(c) })),
    ...(config.remote.enabled ? config.remote.boards.filter((b) => BOARDS[b]).map((b) => ({ name: b, load: BOARDS[b] })) : []),
    ...(config.linkedin.enabled ? [{ name: 'linkedin', load: linkedin }] : []),
  ];
  const queue = sources.filter((s) => !only || s.name.toLowerCase().includes(only));
  // 4 sources at a time; Workable spaces its own calls inside the adapter.
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      try {
        const jobs = await c.load();
        for (const j of jobs) if ((await save(j)) === 'inserted') added++;
        total += jobs.length;
        console.log(`✓ ${c.name}: ${jobs.length} postings`);
      } catch (e) {
        errors.push({ company: c.name, error: (e as Error).message });
        console.log(`✗ ${c.name}: ${(e as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  const waiting = await waitingCount();
  await pool.query(`UPDATE fetch_runs SET finished_at = now(), checked = $2, inserted = $3, new_matches = $4, errors = $5 WHERE id = $1`,
    [run.id, total, added, Math.max(0, waiting - before), JSON.stringify(errors)]);
  console.log(`\n${total} postings checked, ${added} new. ${waiting} matching jobs waiting (status=new).`);
}

/** Re-applies filters and scoring to stored jobs after config.json / match.ts changes (no network). */
export async function rescore() {
  const { rows } = await pool.query<Job>(`SELECT * FROM jobs WHERE status IN ('new', 'filtered')`);
  for (const j of rows) {
    await save({ id: j.id, source: j.source, company: j.company, title: j.title, location: j.location, url: j.url,
      description: j.description, posted_at: j.posted_at ? new Date(j.posted_at).toISOString() : null });
  }
  console.log(`${rows.length} jobs re-scored. ${await waitingCount()} matching jobs waiting (status=new).`);
}
