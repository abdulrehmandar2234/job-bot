import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';

if (!/\/job_bot_test(_[a-z0-9]+)?$/.test(process.env.DATABASE_URL ?? '')) {
  throw new Error(`Refusing to run tests against ${process.env.DATABASE_URL}: only job_bot_test is allowed`);
}

if (typeof document !== 'undefined') {
  const { cleanup } = await import('@testing-library/react');
  afterEach(cleanup);
}
