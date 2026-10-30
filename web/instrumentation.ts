// Runs once when the Next.js server starts, before it handles requests (node_modules/next/dist/docs: instrumentation).
// Applies pending database migrations (lib/migrate.ts), only in the Node.js runtime: lib/bot spawns a child process.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { migrateOnce } = await import('./lib/migrate');
  await migrateOnce();
}
