import { DatabaseError } from 'pg';
import { describe, expect, it } from 'vitest';
import { ActionError, botFailure, expectedFailure, guarded } from '@/lib/action-state';
import { BotStartError } from '@/lib/bot';
import { CvBusyError } from '@/lib/tasks';

const UNREACHABLE = 'The database is not reachable right now. Try again in a moment.';
const sysError = (code: string, syscall: string, message = `${syscall} ${code}`) =>
  Object.assign(new Error(message), { code, syscall, errno: -1 }) as NodeJS.ErrnoException;

describe('expectedFailure', () => {
  it.each<[string, unknown, string | null]>([
    ['an ActionError', new ActionError('Unknown job'), 'Unknown job'],
    ['a CvBusyError', new CvBusyError(), new CvBusyError().message],
    ['a BotStartError', new BotStartError('Could not start the bot: EACCES'), 'Could not start the bot: EACCES'],
    ['a pg DatabaseError', new DatabaseError('invalid input syntax', 10, 'error'), 'Database error: invalid input syntax. Try again.'],
    ['ECONNREFUSED', sysError('ECONNREFUSED', 'connect'), UNREACHABLE],
    ['ENOTFOUND', sysError('ENOTFOUND', 'getaddrinfo'), UNREACHABLE],
    ['ETIMEDOUT', sysError('ETIMEDOUT', 'connect'), UNREACHABLE],
    ['ECONNRESET', sysError('ECONNRESET', 'read'), UNREACHABLE],
    ['EHOSTUNREACH', sysError('EHOSTUNREACH', 'connect'), UNREACHABLE],
    ['EAI_AGAIN', sysError('EAI_AGAIN', 'getaddrinfo'), UNREACHABLE],
    [
      'an AggregateError of refusals (::1 and 127.0.0.1)',
      new AggregateError([sysError('ECONNREFUSED', 'connect'), sysError('ECONNREFUSED', 'connect')]),
      UNREACHABLE,
    ],
    ['pg "Connection terminated unexpectedly"', new Error('Connection terminated unexpectedly'), UNREACHABLE],
    ['pg pool "timeout exceeded when trying to connect"', new Error('timeout exceeded when trying to connect'), UNREACHABLE],
    ['a TypeError (a programmer error)', new TypeError("Cannot read properties of undefined (reading 'status')"), null],
    ['spawn EACCES (not the database)', sysError('EACCES', 'spawn'), null],
    ['mkdir EACCES (not the database)', sysError('EACCES', 'mkdir'), null],
    ['open ENOENT (not the database)', sysError('ENOENT', 'open'), null],
    ['an AggregateError of something else', new AggregateError([new TypeError('x')]), null],
    ['a string', 'boom', null],
  ])('%s', (_, error, expected) => {
    expect(expectedFailure(error)).toBe(expected);
  });

  it('guarded answers expected failures and rethrows programmer errors', async () => {
    expect(
      await guarded(async () => {
        throw new Error('Connection terminated unexpectedly');
      }),
    ).toEqual({ ok: false, message: UNREACHABLE });
    const bug = new TypeError('bug');
    await expect(
      guarded(async () => {
        throw bug;
      }),
    ).rejects.toBe(bug);
  });
});

describe('botFailure', () => {
  it.each<[string, unknown, string]>([
    ['a one-line message', { stderr: 'No job with id x\n' }, 'The bot failed: No job with id x'],
    [
      'the bot line after the .env notice',
      { stderr: '.env not found. Continuing without it.\nCould not check the posting: timeout\n' },
      'The bot failed: Could not check the posting: timeout',
    ],
    [
      'a thrown error with a stack',
      { stderr: 'file:///x/src/cli.ts:10\nError: Unknown job id\n    at main (file:///x/src/cli.ts:10:5)\n' },
      'The bot failed: Unknown job id',
    ],
    [
      'a thrown error after the .env notice',
      { stderr: '.env not found. Continuing without it.\nTypeError: x is not a function\n    at y (file:///a.ts:1:1)' },
      'The bot failed: x is not a function',
    ],
    ['a run stopped at its timeout', { killed: true, stderr: '' }, 'The bot took too long and was stopped. Try again.'],
    [
      'nothing on stderr but the .env notice',
      { stderr: '.env not found. Continuing without it.\n' },
      'The bot failed to run. Try again (its output is in the dashboard terminal).',
    ],
    ['no stderr at all', new Error('spawn failed'), 'The bot failed to run. Try again (its output is in the dashboard terminal).'],
  ])('%s', (_, error, expected) => {
    expect(botFailure(error)).toBe(expected);
  });
});
