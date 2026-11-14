import { config } from '../config.ts';
import { pool, pruneFiltered, withLock, type Job } from '../db.ts';
import { ConfigError } from '../errors.ts';
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
  let allFailed = false;
  const ran = await withLock('fetch', async () => {
    allFailed = (await fetchAll(args, flags)).allFailed;
  });
  if (!ran) console.log('A fetch is already running; skipping.');
  // Every source failing (the Mac is offline, say) is a failed fetch, not "0 postings checked": exit non-zero, so
  // `bot daily` and the dashboard's task report it.
  if (allFailed) process.exitCode = 1;
}

/** The line `fetch` prints when no source worked; `bot daily` (src/commands/daily.ts) reads it. */
export const allSourcesFailed = (n: number, first: { company: string; error: string }) =>
  `✗ All ${n} sources failed — is the network up? First error: ${first.company}: ${first.error.replace(/\s+/g, ' ')}`;

async function fetchAll(_args: string[], flags: Flags): Promise<{ allFailed: boolean }> {
  const only = flags.company?.toLowerCase();
  const {
    rows: [run],
  } = await pool.query<{ id: number }>('INSERT INTO fetch_runs DEFAULT VALUES RETURNING id');
  let before = 0;
  let waiting: number | null = null;
  let added = 0,
    total = 0;
  let fatal = false;
  let allFailed = false;
  // Sources that ran, and those that brought nothing back because of an error (the source's own, not the database's).
  let ran = 0;
  const failed: { company: string; error: string }[] = [];
  const errors: { company: string; error: string }[] = [];
  try {
    before = await waitingCount();
    const sources: { name: string; load: () => Promise<Fetched> }[] = [
      ...config.companies.map((c) => ({ name: c.name, load: () => fetchCompany(c) })),
      ...(config.remote.enabled ? config.remote.boards.filter((b) => BOARDS[b]).map((b) => ({ name: b, load: BOARDS[b] })) : []),
      ...(config.linkedin.enabled ? [{ name: 'linkedin', load: linkedin }] : []),
    ];
    const queue = sources.filter((s) => !only || s.name.toLowerCase().includes(only));
    // A settings problem scoring hits (unknown stack, missing master CV) fails every posting alike: the first one stops
    // the fetch, and it is reported once as the fetch's own error, not as "N of M postings not saved" per source.
    let configError = null as ConfigError | null;
    // 4 sources at a time; Workable spaces its own calls inside the adapter.
    const worker = async () => {
      for (let c = queue.shift(); c && !configError; c = queue.shift()) {
        ran++;
        try {
          const jobs = await c.load();
          if (jobs.skipped) {
            ran--; // not run, so it neither failed nor counts towards "all sources failed"
            console.log(`- ${c.name}: skipped (${jobs.skipped})`);
            continue;
          }
          if (!jobs.length && jobs.partialError) failed.push({ company: c.name, error: jobs.partialError });
          // One posting the database rejects must not cost the rest of the source.
          let skipped = 0;
          let firstError = '';
          for (const j of jobs) {
            try {
              if ((await save(j)) === 'inserted') added++;
            } catch (e) {
              if (e instanceof ConfigError) {
                configError ??= e;
                queue.length = 0;
                return;
              }
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
          failed.push({ company: c.name, error: (e as Error).message });
          console.log(`✗ ${c.name}: ${(e as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    if (configError) throw configError;
    waiting = await waitingCount();
    console.log(`\n${total} postings checked, ${added} new. ${waiting} matching jobs waiting (status=new).`);
    allFailed = ran > 0 && failed.length === ran;
    if (allFailed) console.error(allSourcesFailed(ran, failed[0]));
    else if (failed.length)
      console.log(`! ${failed.length} of ${ran} sources failed (first error: ${failed[0].company}: ${failed[0].error})`);
    // Housekeeping after a full fetch that reached the sources: old filtered postings nobody needs any more.
    if (!only && !allFailed) {
      try {
        const pruned = await pruneFiltered(config.maxAgeDays);
        if (pruned) console.log(`${pruned} old filtered postings deleted.`);
      } catch (e) {
        console.log(`! pruning old filtered postings failed: ${(e as Error).message}`);
      }
    }
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
  return { allFailed };
}

// A salary that came from a source's API is not in the text, so re-parsing would lose it.
export const keptSalary = (j: Job) => (SALARY_SOURCES.includes(j.source) ? rowSalary(j) : null) ?? undefined;

/**
 * Scores a stored new or filtered job again (moving it between the two) and saves it; `location` replaces its own.
 * No fetch saw it, so its fetched_at ("last seen by a fetch") stays as it was.
 */
export function saveAgain(j: Job, location = j.location) {
  return save({
    seen: false,
    id: j.id,
    source: j.source,
    company: j.company,
    title: j.title,
    location,
    url: j.url,
    description: j.description,
    posted_at: j.posted_at ? new Date(j.posted_at).toISOString() : null,
    salary: keptSalary(j),
  });
}

/** Re-applies filters and scoring to stored jobs after config.json / match.ts changes (no network). */
export async function rescore() {
  const { rows } = await pool.query<Job>(`SELECT * FROM jobs WHERE status IN ('new', 'filtered')`);
  for (const j of rows) await saveAgain(j);
  // Jobs the user acted on keep their status and score, but their salary and visa note are filled in (or corrected),
  // and their skills match follows the master CV as it is now (a skill removed from it is no longer "you have").
  // A job the filters would now drop keeps its old skills match: scoring stopped before it compared the skills.
  const { rows: acted } = await pool.query<Job>(`SELECT * FROM jobs WHERE status NOT IN ('new', 'filtered')`);
  for (const j of acted) {
    const s = keptSalary(j) ?? parseSalary(`${j.title}\n${j.description}`, j.country, homeCountry());
    const scored = scoreJob({ ...j, posted_at: null }, config);
    const skills = scored.filterReason ? null : scored;
    await pool.query(
      `UPDATE jobs SET salary_min = $2, salary_max = $3, salary_currency = $4, salary_period = $5,
        visa = coalesce($6, visa), visa_evidence = coalesce($7, visa_evidence),
        matched = coalesce($8, matched), missing = coalesce($9, missing) WHERE id = $1`,
      [
        j.id,
        s?.min ?? null,
        s?.max ?? null,
        s?.currency ?? null,
        s?.period ?? null,
        scored.visa,
        scored.visaEvidence,
        skills?.matched ?? null,
        skills?.missing ?? null,
      ],
    );
  }
  console.log(`${rows.length} jobs re-scored. ${await waitingCount()} matching jobs waiting (status=new).`);
}
