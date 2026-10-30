import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch } from './helpers.ts';
import { aiLabel, aiModel, aiProvider, askAi, askApi, parseReply } from '../src/ai-providers.ts';
import type { AiSettings } from '../src/settings.ts';
import { timing } from '../src/sources/http.ts';

// OpenAI and DeepSeek over HTTP, with fetch mocked: no request ever leaves the machine and no real key is used.
const KEY = 'sk-test-secret-1234567890';
const SCHEMA = {
  type: 'object',
  properties: { score: { type: 'integer' }, verdict: { type: 'string' } },
  required: ['score', 'verdict'],
};
const base: AiSettings = {
  enabled: true,
  claudePath: 'claude',
  scoreModel: 'haiku',
  letterModel: 'sonnet',
  maxScorePerRun: 5,
  concurrency: 1,
};
const openai: AiSettings = { ...base, provider: 'openai' };
const deepseek: AiSettings = { ...base, provider: 'deepseek' };

/** A Chat Completions reply whose message content is `content`. */
const reply = (content: string) => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });

type Seen = { url: string; headers: Record<string, string>; body: Record<string, any> };
let mock: ReturnType<typeof mockFetch> | null = null;
function serve(...answers: (object | Response)[]) {
  const seen: Seen[] = [];
  mock = mockFetch({
    'https://': (url: string, init?: RequestInit) => {
      seen.push({ url, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
      const next = answers.shift() ?? answers.at(-1);
      return next instanceof Response ? next : Response.json(next);
    },
  });
  return seen;
}

beforeEach(() => {
  timing.scale = 0;
  process.env.OPENAI_API_KEY = KEY;
  process.env.DEEPSEEK_API_KEY = KEY;
});
afterEach(() => {
  mock?.restore();
  mock = null;
  timing.scale = 1;
  delete process.env.OPENAI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
});

describe('provider and model choice', () => {
  it('defaults to the Claude CLI with its own models', () => {
    assert.equal(aiProvider(base), 'claude-cli');
    assert.equal(aiModel('score', base), 'haiku');
    assert.equal(aiModel('letter', base), 'sonnet');
    assert.equal(aiLabel('score', base), 'Claude CLI haiku');
  });

  it('uses each API provider defaults, or the models in config.json', () => {
    assert.deepEqual([aiModel('score', openai), aiModel('letter', openai)], ['gpt-4o-mini', 'gpt-4o']);
    assert.deepEqual([aiModel('score', deepseek), aiModel('letter', deepseek)], ['deepseek-chat', 'deepseek-chat']);
    const own = { ...openai, openai: { scoreModel: 'gpt-4.1-mini' } };
    assert.deepEqual([aiModel('score', own), aiModel('letter', own)], ['gpt-4.1-mini', 'gpt-4o']);
    assert.equal(aiLabel('letter', deepseek), 'DeepSeek deepseek-chat');
  });
});

describe('OpenAI', () => {
  it('posts Chat Completions with the key, the model and a json_schema response format', async () => {
    const seen = serve(reply('{"score":80,"verdict":"good"}'));
    const out = await askAi('the job', SCHEMA, 'score', 'be a recruiter', openai);
    assert.deepEqual(out, { score: 80, verdict: 'good' });
    assert.equal(seen.length, 1);
    const [{ url, headers, body }] = seen;
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(headers.authorization, `Bearer ${KEY}`);
    assert.equal(body.model, 'gpt-4o-mini');
    assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'job_bot_score', schema: SCHEMA, strict: false } });
    assert.deepEqual(body.messages, [
      { role: 'system', content: 'be a recruiter' },
      { role: 'user', content: 'the job' },
    ]);
    assert.ok(body.temperature <= 0.3, 'scoring runs at a low temperature');
  });

  it('uses the letter model and a configured base URL', async () => {
    const seen = serve(reply('{"letter":"Dear"}'));
    const ai = { ...openai, openai: { letterModel: 'gpt-4.1', baseUrl: 'https://proxy.example.test/' } };
    await askAi('cv', { type: 'object', required: ['letter'] }, 'letter', 's', ai);
    assert.equal(seen[0].url, 'https://proxy.example.test/v1/chat/completions');
    assert.equal(seen[0].body.model, 'gpt-4.1');
  });

  it('asks once more when the reply is not valid JSON, then succeeds', async () => {
    const seen = serve(reply('Sure! Here is the review'), reply('{"score":70,"verdict":"good"}'));
    assert.deepEqual(await askAi('p', SCHEMA, 'score', 's', openai), { score: 70, verdict: 'good' });
    assert.equal(seen.length, 2);
  });

  it('fails after the second unusable reply, naming what was wrong', async () => {
    const seen = serve(reply('{"score":70}'), reply('{"score":71}'));
    await assert.rejects(askAi('p', SCHEMA, 'score', 's', openai), /OpenAI gave no usable answer after 2 tries: reply is missing verdict/);
    assert.equal(seen.length, 2);
  });

  it('fails fast on 401 with a clear message that never contains the key', async () => {
    const seen = serve(Response.json({ error: { message: `Incorrect API key provided: ${KEY}` } }, { status: 401 }));
    await assert.rejects(askAi('p', SCHEMA, 'score', 's', openai), (e: Error) => {
      assert.match(e.message, /OpenAI rejected the API key \(OPENAI_API_KEY\)/);
      assert.ok(!e.message.includes(KEY));
      return true;
    });
    assert.equal(seen.length, 1, '401 is not retried');
  });

  it('redacts the key from other API errors and reports the provider message', async () => {
    serve(Response.json({ error: { message: `model not found for ${KEY}` } }, { status: 404 }));
    await assert.rejects(askAi('p', SCHEMA, 'score', 's', openai), (e: Error) => {
      assert.match(e.message, /OpenAI request failed: 404 model not found/);
      assert.ok(!e.message.includes(KEY));
      return true;
    });
  });

  it('retries a 5xx before giving up', async () => {
    const seen = serve(new Response('busy', { status: 503 }), reply('{"score":1,"verdict":"poor"}'));
    assert.deepEqual(await askAi('p', SCHEMA, 'score', 's', openai), { score: 1, verdict: 'poor' });
    assert.equal(seen.length, 2);
  });

  it('a missing key is a clear error before any request', async () => {
    delete process.env.OPENAI_API_KEY;
    const seen = serve(reply('{}'));
    await assert.rejects(askAi('p', SCHEMA, 'score', 's', openai), /OpenAI needs an API key: set OPENAI_API_KEY in \.env/);
    assert.equal(seen.length, 0);
  });
});

describe('DeepSeek', () => {
  it('posts to /chat/completions with json_object and the schema in the system prompt', async () => {
    const seen = serve(reply('{"score":90,"verdict":"strong"}'));
    assert.deepEqual(await askAi('the job', SCHEMA, 'score', 'be a recruiter', deepseek), { score: 90, verdict: 'strong' });
    const [{ url, headers, body }] = seen;
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(headers.authorization, `Bearer ${KEY}`);
    assert.equal(body.model, 'deepseek-chat');
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.match(body.messages[0].content, /^be a recruiter\n\nReply with one JSON object only/);
    assert.ok(body.messages[0].content.includes(JSON.stringify(SCHEMA)));
    assert.equal(body.messages[1].content, 'the job');
    assert.ok(body.temperature <= 0.3);
  });

  it('accepts JSON wrapped in a markdown fence, and retries invalid JSON once', async () => {
    const seen = serve(reply('{"score": 5,'), reply('```json\n{"score":5,"verdict":"poor"}\n```'));
    assert.deepEqual(await askApi('deepseek', { prompt: 'p', schema: SCHEMA, kind: 'score', system: 's' }, deepseek), {
      score: 5,
      verdict: 'poor',
    });
    assert.equal(seen.length, 2);
  });

  it('fails fast on 401 and 403 without the key in the message', async () => {
    for (const status of [401, 403]) {
      const seen = serve(Response.json({ error: { message: 'Authentication Fails' } }, { status }));
      await assert.rejects(askAi('p', SCHEMA, 'score', 's', deepseek), (e: Error) => {
        assert.match(e.message, /DeepSeek rejected the API key \(DEEPSEEK_API_KEY\)/);
        assert.ok(!e.message.includes(KEY));
        return true;
      });
      assert.equal(seen.length, 1);
      mock!.restore();
    }
  });

  it('a missing key is a clear error before any request', async () => {
    process.env.DEEPSEEK_API_KEY = '  ';
    const seen = serve(reply('{}'));
    await assert.rejects(askAi('p', SCHEMA, 'letter', 's', deepseek), /DeepSeek needs an API key: set DEEPSEEK_API_KEY/);
    assert.equal(seen.length, 0);
  });
});

describe('parseReply', () => {
  it('reports a refusal as such', () => {
    assert.throws(() => parseReply({ choices: [{ message: { content: null, refusal: 'no' } }] }, SCHEMA), /the model refused: no/);
  });
  it('rejects an empty reply and a JSON array', () => {
    assert.throws(() => parseReply({ choices: [] }, SCHEMA), /empty reply/);
    assert.throws(() => parseReply(reply('[1]'), SCHEMA), /not a JSON object/);
  });
});
