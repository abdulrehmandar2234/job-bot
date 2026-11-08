import { describe, expect, it } from 'vitest';
import { SKIP_LABEL, SKIP_REASONS, skipReason } from '@/lib/skips';

describe('skip reasons', () => {
  it('every reason has a label, in the order the bot lists them', () => {
    expect(Object.keys(SKIP_LABEL)).toEqual([...SKIP_REASONS]);
  });

  it('skipReason keeps known reasons only', () => {
    expect(skipReason('stack')).toBe('stack');
    for (const v of ['', 'boredom', null, 'STACK']) expect(skipReason(v)).toBeNull();
  });
});
