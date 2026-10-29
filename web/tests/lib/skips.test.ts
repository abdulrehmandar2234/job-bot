import { describe, expect, it } from 'vitest';
import { SKIP_LABEL, SKIP_REASONS, skipReason } from '@/lib/skips';
import { SKIP_REASONS as BOT_SKIP_REASONS } from '../../../src/db';

describe('skip reasons', () => {
  it('match the bot\'s list and all have a label', () => {
    expect(SKIP_REASONS).toEqual(BOT_SKIP_REASONS);
    expect(Object.keys(SKIP_LABEL)).toEqual([...SKIP_REASONS]);
  });

  it('skipReason keeps known reasons only', () => {
    expect(skipReason('stack')).toBe('stack');
    for (const v of ['', 'boredom', null, 'STACK']) expect(skipReason(v)).toBeNull();
  });
});
