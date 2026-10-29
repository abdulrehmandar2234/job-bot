// Creates test databases (never job_bot itself): node scripts/create-test-db.mjs job_bot_test_bot_x job_bot_test_x
import pg from 'pg';

const names = process.argv.slice(2);
if (!names.length || names.some((n) => !/^job_bot_test(_bot)?(_[a-z0-9]+)?$/.test(n))) {
  console.error('Usage: create-test-db.mjs job_bot_test[_bot][_name] ...');
  process.exit(1);
}
const client = new pg.Client('postgres://postgres@127.0.0.1:5432/postgres');
await client.connect();
for (const name of names) {
  const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (!rowCount) await client.query(`CREATE DATABASE ${name}`);
  console.log(`${rowCount ? 'exists ' : 'created'} ${name}`);
}
await client.end();
