import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JOB_STATUSES } from '../src/db.ts';
import type { JobStatus } from '../src/types.ts';
import { STATUSES } from '../web/lib/db.ts';

// Compile-time half of the check (npm run typecheck): both lists hold exactly the JobStatus union.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const botMatchesType: Same<(typeof JOB_STATUSES)[number], JobStatus> = true;
const webMatchesType: Same<(typeof STATUSES)[number], JobStatus> = true;

describe('job statuses', () => {
  it('the dashboard lists the same statuses as the bot, in the same order', () => {
    assert.ok(botMatchesType && webMatchesType);
    assert.deepEqual([...STATUSES], [...JOB_STATUSES]);
  });
});
