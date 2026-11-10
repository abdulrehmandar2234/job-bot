import { join } from 'node:path';

// cv/master.json is the user's own and gitignored, so a checkout (CI) has none. Tests use the owner's CV with
// placeholder contact details. Import this before anything that reads the master CV; it needs no database, so the
// database-free tests (CI's Windows job) can import it too. tests/helpers.ts imports it.
export const OWNER_MASTER = join(import.meta.dirname, 'fixtures', 'master-owner.json');
process.env.JOB_BOT_MASTER ||= OWNER_MASTER;
