import { config } from '../config.ts';
import { pool, withLock, type Job } from '../db.ts';
import { fetchCompany, type Fetched } from '../sources/index.ts';
import { BOARDS } from '../sources/boards.ts';
import { linkedin } from '../sources/linkedin.ts';
import { parseSalary, rowSalary, SALARY_SOURCES } from '../salary.ts';
import { homeCountry, save, type Flags } from './shared.ts';
import { scoreJob } from '../match.ts';

const waitingCount = async () => (await pool.query<{ n: number }>(`SELECT count(*)::int n FROM jobs WHERE status = 'new'`)).rows[0].n;

/**
 * fetch [--company name]: pulls jobs from every source, then filters and scores them. Only one fetch runs at a time
 * (the dashboard's Fetch task and the daily script would otherwise hit every board twice).
 */
export async function fetch(args: string[], flags: Flags) {
  if (!(await withLock('fetch', () => fetchAll(args, flags)))) console.log('A fetch is already running; skipping.');
}

async function fetchAll(_args: string[], flags: Flags) {
  const only = flags.company?.toLowerCase();
  const {
    rows: [run],
  } = await pool.query<{ id: number }>('INSERT INTO fetch_runs DEFAULT VALUES RETURNING id');
  let before = 0;
  let waiting: number | null = null;
  let added = 0,
    total = 0;
  let fatal = false;
  const errors: { company: string; error: string }[] = [];
  try {
    before = await waitingCount();
    const sources: { name: string; load: () => Promise<Fetched> }[] = [
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
          // One posting the database rejects must not cost the rest of the source.
          let skipped = 0;
          let firstError = '';
          for (const j of jobs) {
            try {
              if ((await save(j)) === 'inserted') added++;
            } catch (e) {
              skipped++;
              firstError ||= `${j.id}: ${(e as Error).message}`;
            }
          }
          total += jobs.length - skipped;
          if (jobs.partialError) errors.push({ company: c.name, error: jobs.partialError });
          if (skipped) errors.push({ company: c.name, error: `${skipped} of ${jobs.length} postings not saved (first: ${firstError})` });
          const notes = [jobs.partialError, skipped ? `${skipped} skipped` : ''].filter(Boolean).join('; ');
          console.log(`${notes ? '!' : '✓'} ${c.name}: ${jobs.length - skipped} postings${notes ? ` (${notes})` : ''}`);
        } catch (e) {
          errors.push({ company: c.name, error: (e as Error).message });
          console.log(`✗ ${c.name}: ${(e as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    waiting = await waitingCount();
    console.log(`\n${total} postings checked, ${added} new. ${waiting} matching jobs waiting (status=new).`);
  } catch (e) {
    // Recorded on the run row below, so the dashboard shows why the fetch stopped; then rethrown for the CLI.
    fatal = true;
    errors.push({ company: 'fetch', error: (e as Error).message });
    throw e;
  } finally {
    // Always stamp finished_at: a crashed fetch must not look like one that is still running.
    const matches = Math.max(0, (waiting ?? (await waitingCount().catch(() => before))) - before);
    const update = pool.query(
      `UPDATE fetch_runs SET finished_at = now(), checked = $2, inserted = $3, new_matches = $4, errors = $5 WHERE id = $1`,
      [run.id, total, added, matches, JSON.stringify(errors)],
    );
    // After a fatal error the update is best-effort, so a broken connection cannot mask the original error.
    if (fatal) await update.catch((e: Error) => console.log(`! fetch run ${run.id} not closed: ${e.message}`));
    else await update;
  }
}

// A salary that came from a source's API is not in the text, so re-parsing would lose it.
const keptSalary = (j: Job) => (SALARY_SOURCES.includes(j.source) ? rowSalary(j) : null) ?? undefined;

/** Re-applies filters and scoring to stored jobs after config.json / match.ts changes (no network). */
export async function rescore() {
  const { rows } = await pool.query<Job>(`SELECT * FROM jobs WHERE status IN ('new', 'filtered')`);
  for (const j of rows) {
    await save({
      id: j.id,
      source: j.source,
      company: j.company,
      title: j.title,
      location: j.location,
      url: j.url,
      description: j.description,
      posted_at: j.posted_at ? new Date(j.posted_at).toISOString() : null,
      salary: keptSalary(j),
    });
  }
  // Jobs the user acted on are not re-scored, but their salary and visa note are filled in (or corrected) too.
  const { rows: acted } = await pool.query<Job>(`SELECT * FROM jobs WHERE status NOT IN ('new', 'filtered')`);
  for (const j of acted) {
    const s = keptSalary(j) ?? parseSalary(`${j.title}\n${j.description}`, j.country, homeCountry());
    const scored = scoreJob({ ...j, posted_at: null });
    await pool.query(
      `UPDATE jobs SET salary_min = $2, salary_max = $3, salary_currency = $4, salary_period = $5,
        visa = coalesce($6, visa), visa_evidence = coalesce($7, visa_evidence) WHERE id = $1`,
      [j.id, s?.min ?? null, s?.max ?? null, s?.currency ?? null, s?.period ?? null, scored.visa, scored.visaEvidence],
    );
  }
  console.log(`${rows.length} jobs re-scored. ${await waitingCount()} matching jobs waiting (status=new).`);
}
