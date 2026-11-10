import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.ts'; // first: it points the bot at a temp config before src/ loads one
import { ConfigError, UserError } from '../src/errors.ts';
import { AiError } from '../src/ai-providers.ts';
import { InvalidSettingsError } from '../src/settings.ts';

describe('UserError: the errors the CLI prints as one line', () => {
  it('ConfigError, AiError and InvalidSettingsError are UserErrors with their own names and fields', () => {
    const config = new ConfigError('bad stack');
    assert.ok(config instanceof UserError && config instanceof Error);
    assert.equal(config.name, 'ConfigError');
    assert.equal(config.message, 'bad stack');

    const ai = new AiError('no key', { fatal: true, timedOut: true });
    assert.ok(ai instanceof UserError);
    assert.equal(ai.name, 'AiError');
    assert.equal(ai.fatal, true);
    assert.equal(ai.timedOut, true);
    const plain = new AiError('slow');
    assert.equal(plain.fatal, false);
    assert.equal(plain.timedOut, false);

    const settings = new InvalidSettingsError('config.json', [{ path: 'minScore', message: 'Expected number' }]);
    assert.ok(settings instanceof UserError);
    assert.equal(settings.name, 'InvalidSettingsError');
    assert.equal(settings.file, 'config.json');
    assert.deepEqual(settings.errors, [{ path: 'minScore', message: 'Expected number' }]);
    assert.match(settings.message, /Invalid settings file config\.json:\n {2}- minScore: Expected number/);
  });

  it('a plain UserError is named UserError, and other errors are not UserErrors', () => {
    assert.equal(new UserError('x').name, 'UserError');
    assert.ok(!(new Error('x') instanceof UserError));
  });
});
