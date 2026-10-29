import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The DB tests talk to a real Postgres database, so this must never be the dashboard's own `job_bot`.
// WEB_TEST_DB picks another test database (job_bot_test_<name>) so parallel worktrees do not collide.
const TEST_DATABASE_URL = `postgres://postgres@127.0.0.1:5432/${process.env.WEB_TEST_DB ?? 'job_bot_test'}`;

export default defineConfig({
  plugins: [react()],
  resolve: { tsconfigPaths: true }, // `@/*` -> web root, from tsconfig.json
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node', // component tests opt in with `// @vitest-environment jsdom`
    // Set before any test file is loaded, so lib/db.ts creates its Pool against the test database.
    env: { DATABASE_URL: TEST_DATABASE_URL, TZ: 'UTC' },
    setupFiles: ['tests/setup.ts'],
    // The test database is shared with the bot's own tests: one file at a time.
    fileParallelism: false,
    coverage: { provider: 'v8', include: ['app/**', 'components/**', 'lib/**'], reporter: ['text-summary', 'html'] },
  },
});
