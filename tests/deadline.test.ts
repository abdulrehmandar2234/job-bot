import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { daysLeft, localToday, parseDeadline } from '../src/deadline.ts';

const POSTED = new Date('2026-11-10T08:00:00Z');

describe('parseDeadline', () => {
  it('reads the usual deadline phrases and date formats', () => {
    for (const [text, want] of [
      ['Application deadline: 30 November 2026', '2026-11-30'],
      ['Apply by November 30, 2026.', '2026-11-30'],
      ['Closing date: 30/11/2026', '2026-11-30'],
      ['Applications close on Friday, 4th December 2026', '2026-12-04'],
      ['Deadline 2026-12-01', '2026-12-01'],
      ['Last date to apply: 05.12.2026', '2026-12-05'],
      ['This vacancy closes on 15 Dec 2026', '2026-12-15'],
      ['Open until 11/30/2026', '2026-11-30'],
      ['We are accepting applications until the 20th of December', '2026-12-20'],
      ['APPLY BEFORE 1 JAN', '2027-01-01'],
    ] as const)
      assert.equal(parseDeadline(`About the role\n${text}\nBenefits`, POSTED), want, text);
  });

  it('ignores dates that are not after a deadline phrase', () => {
    assert.equal(parseDeadline('Start date: 1 January 2027. Posted on 10 November 2026.', POSTED), null);
    assert.equal(parseDeadline('Deadline-driven team shipping weekly.', POSTED), null);
    assert.equal(parseDeadline('Application deadline: ASAP', POSTED), null);
  });

  it('a date without a year is the next one after the posting date', () => {
    assert.equal(parseDeadline('Apply by 30 November', POSTED), '2026-11-30');
    assert.equal(parseDeadline('Apply by 15 January', POSTED), '2027-01-15');
  });

  it('drops impossible or far-off dates', () => {
    assert.equal(parseDeadline('Deadline: 31 February 2027', POSTED), null);
    assert.equal(parseDeadline('Deadline: 1 January 2020', POSTED), null);
    assert.equal(parseDeadline('Deadline: 1 January 2030', POSTED), null);
  });

  it('takes the first deadline phrase that has a date', () => {
    assert.equal(parseDeadline('Deadline: ASAP. Applications close on 3 December 2026.', POSTED), '2026-12-03');
  });
});

describe('daysLeft / localToday', () => {
  it('counts whole calendar days', () => {
    assert.equal(daysLeft('2026-11-30', '2026-11-23'), 7);
    assert.equal(daysLeft('2026-11-30', '2026-11-30'), 0);
    assert.equal(daysLeft('2026-11-29', '2026-11-30'), -1);
    assert.equal(daysLeft('2027-01-02', '2026-12-30'), 3);
  });

  it('localToday is the local calendar date', () => {
    assert.equal(localToday(new Date(2026, 0, 5, 23, 30)), '2026-01-05');
  });
});
