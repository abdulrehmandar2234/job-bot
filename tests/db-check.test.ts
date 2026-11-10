import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_DB } from './helpers.ts';
import { checkDatabase, databaseName } from '../src/db-check.ts';

// What `setup` and `doctor` learn about DATABASE_URL, against the test server: there, missing, or unreachable.
// Only connects (to the test database or a name that does not exist); never creates or changes a database.

describe('checkDatabase', () => {
  it('ok for the test database', async () => {
    assert.deepEqual(await checkDatabase(TEST_DB), { state: 'ok' });
  });

  it('missing, with its name, when the server answers but the database does not exist', async () => {
    const url = TEST_DB.replace(/\/[^/]+$/, '/job_bot_test_bot_does_not_exist');
    assert.deepEqual(await checkDatabase(url), { state: 'missing', name: 'job_bot_test_bot_does_not_exist' });
  });

  it('an error naming the server when nothing listens, without the password', async () => {
    const res = await checkDatabase('postgres://someone:secret@127.0.0.1:1/x');
    assert.deepEqual(res, { state: 'error', message: 'nothing answers at someone@127.0.0.1:1: is PostgreSQL running?' });
  });

  it('an error for a string that is not a connection string', async () => {
    const res = await checkDatabase('postgres://user@host:notaport/db');
    assert.equal(res.state, 'error');
  });

  it('databaseName reads the name from the path, decoded', () => {
    assert.equal(databaseName('postgres://postgres@127.0.0.1:5432/job_bot'), 'job_bot');
    assert.equal(databaseName('postgres://u:p@h/my%20db'), 'my db');
  });
});
