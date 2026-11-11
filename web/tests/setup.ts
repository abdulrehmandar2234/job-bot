import '@testing-library/jest-dom/vitest';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

if (!/\/job_bot_test(_[a-z0-9]+)?$/.test(process.env.DATABASE_URL ?? '')) {
  throw new Error(`Refusing to run tests against ${process.env.DATABASE_URL}: only job_bot_test is allowed`);
}

// config.json is personal and gitignored: tests read a temp copy of the shipped config.default.json, so they never
// depend on (or write) whoever runs them. Tests of other settings stub JOB_BOT_CONFIG themselves.
if (!process.env.JOB_BOT_CONFIG) {
  process.env.JOB_BOT_CONFIG = join(mkdtempSync(join(tmpdir(), 'talaash-web-config-')), 'config.json');
  copyFileSync(join(import.meta.dirname, '..', '..', 'config.default.json'), process.env.JOB_BOT_CONFIG);
}

// Never write the real data/ folder (data/logs/tasks.log, temp settings files, data/imports, the import token) from a
// test: the dashboard and the bot runs it starts write there through dataDir() (src/settings.ts), which reads this.
process.env.JOB_BOT_DATA_DIR ||= mkdtempSync(join(tmpdir(), 'talaash-web-data-'));

// cv/master.json is the user's own and gitignored: tests read the owner's CV with placeholder contact details.
process.env.JOB_BOT_MASTER ||= join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'master-owner.json');

if (typeof document !== 'undefined') {
  const { cleanup } = await import('@testing-library/react');
  afterEach(cleanup);
}
