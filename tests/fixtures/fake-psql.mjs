// A stand-in for psql in tests of `bot restore` (src/backup.ts): `node fake-psql.mjs <psql arguments>`.
// Each call appends one JSON line to FAKE_PSQL_LOG: { args, stdin, password } (password: the PGPASSWORD it was given).
// It answers the queries restore sends with -c:
//   the table list (pg_tables)  FAKE_PSQL_TABLES, comma-separated, e.g. "public.jobs,public.schema_migrations"
//   count(*) FROM public.jobs   FAKE_PSQL_JOBS (default 0)
//   max(version)                FAKE_PSQL_MIGRATION (default 015_cover_letter_ai_error)
// FAKE_PSQL_FAIL makes the load (a call without -c) print that message on stderr and exit 3, as ON_ERROR_STOP does.
// FAKE_PSQL_CONNECT_FAIL makes every call print that message and exit 2, as a failed connection does.
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
if (process.env.FAKE_PSQL_LOG)
  appendFileSync(process.env.FAKE_PSQL_LOG, `${JSON.stringify({ args, stdin, password: process.env.PGPASSWORD ?? null })}\n`);

if (process.env.FAKE_PSQL_CONNECT_FAIL) {
  process.stderr.write(`${process.env.FAKE_PSQL_CONNECT_FAIL}\n`);
  process.exit(2);
}
const c = args.indexOf('-c');
if (c === -1) {
  if (process.env.FAKE_PSQL_FAIL) {
    process.stderr.write(`${process.env.FAKE_PSQL_FAIL}\n`);
    process.exit(3);
  }
  process.exit(0);
}
const sql = args[c + 1];
if (sql.includes('pg_tables')) process.stdout.write((process.env.FAKE_PSQL_TABLES ?? '').split(',').filter(Boolean).join('\n'));
else if (sql.includes('public.jobs')) process.stdout.write(`${process.env.FAKE_PSQL_JOBS ?? '0'}\n`);
else if (sql.includes('max(version)')) process.stdout.write(`${process.env.FAKE_PSQL_MIGRATION ?? '015_cover_letter_ai_error'}\n`);
