import pg from 'pg';

// Is the database in DATABASE_URL there, and can we make it? Used by `setup` (offers to create a missing database)
// and `doctor` (reports it). Never touches tables: migrations stay with src/migrate.ts.

export type DbState = { state: 'ok' } | { state: 'missing'; name: string } | { state: 'error'; message: string };

/** The database name in a connection string ("job_bot" for postgres://postgres@127.0.0.1:5432/job_bot). */
export const databaseName = (url: string) => decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));

/** Where a connection string points, without the password: "postgres@127.0.0.1:5432". */
const where = (url: string) => {
  const u = new URL(url);
  return `${u.username ? `${decodeURIComponent(u.username)}@` : ''}${u.host}`;
};

/** Connects once: `ok`, `missing` (the server answers, the database does not exist) or `error` with a short reason. */
export async function checkDatabase(url: string): Promise<DbState> {
  let client: pg.Client;
  try {
    client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  } catch (e) {
    return { state: 'error', message: `not a valid connection string (${(e as Error).message})` };
  }
  try {
    await client.connect();
    return { state: 'ok' };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === '3D000') return { state: 'missing', name: databaseName(url) };
    if (err.code === 'ECONNREFUSED') return { state: 'error', message: `nothing answers at ${where(url)}: is PostgreSQL running?` };
    if (err.code === '28P01' || err.code === '28000') return { state: 'error', message: `the server refused the login for ${where(url)}` };
    return { state: 'error', message: err.message };
  } finally {
    await client.end().catch(() => {});
  }
}

/** Creates the database named in `url`, connecting to the server's `postgres` database to do it. */
export async function createDatabase(url: string): Promise<void> {
  const name = databaseName(url);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString(), connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
  } finally {
    await client.end().catch(() => {});
  }
}
