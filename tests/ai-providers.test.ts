import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch } from './helpers.ts';
import { API_PRESETS, PRESETS, detectPreset } from '../src/ai-presets.ts';
import {
  AI_BUDGET,
  AiError,
  aiLabel,
  aiModel,
  askAi,
  chatBody,
  keyRejected,
  noCredit,
  parseReply,
  providerMode,
  resolveApi,
  resolveClaude,
} from '../src/ai-providers.ts';
import type { AiSettings } from '../src/settings.ts';
import { timing } from '../src/sources/http.ts';

// The API provider over HTTP, with fetch mocked: no request ever leaves the machine and no real key is used.
const KEY = 'sk-test-secret-1234567890';
const ANT = 'sk-ant-test-secret-0987654321';
const ENV = ['AI_API_KEY', 'AI_BASE_URL', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY'];
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
const api = (a: AiSettings['api'] = {}): AiSettings => ({ ...base, provider: 'api', api: a });

/** A Chat Completions reply whose message content is `content`. */
const reply = (content: string) => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });

type Seen = { url: string; headers: Record<string, string>; body: Record<string, any> };
let mock: ReturnType<typeof mockFetch> | null = null;
function serve(...answers: (object | Response)[]) {
  const seen: Seen[] = [];
  mock = mockFetch({
    http: (url: string, init?: RequestInit) => {
      seen.push({ url, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
      const next = answers.shift() ?? answers.at(-1);
      return next instanceof Response ? next : Response.json(next);
    },
  });
  return seen;
}
/** Timers keeping the process alive: a backoff or budget timer left behind would hold the CLI open after the error. */
const liveTimers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
const noKeyIn = (e: Error) => {
  for (const k of [KEY, ANT]) assert.ok(!e.message.includes(k), e.message);
  return true;
};

beforeEach(() => {
  timing.scale = 0;
  for (const k of ENV) delete process.env[k];
  process.env.AI_API_KEY = KEY;
});
afterEach(() => {
  mock?.restore();
  mock = null;
  timing.scale = 1;
  for (const k of ENV) delete process.env[k];
});

describe('resolveClaude', () => {
  const at =
    (...files: string[]) =>
    (p: string) =>
      files.includes(p);

  it('a bare name is found on PATH first, then in ~/.local/bin; a path is used as given', () => {
    assert.equal(
      resolveClaude('claude', { PATH: '/usr/bin:/opt/x' }, 'darwin', '/Users/a', at('/opt/x/claude', '/Users/a/.local/bin/claude')),
      '/opt/x/claude',
    );
    assert.equal(
      resolveClaude('claude', { PATH: '/usr/bin' }, 'darwin', '/Users/a', at('/Users/a/.local/bin/claude')),
      '/Users/a/.local/bin/claude',
    );
    assert.equal(resolveClaude('claude', { PATH: '/usr/bin' }, 'linux', '/home/a', at()), 'claude'); // left to the OS, which reports it
    assert.equal(resolveClaude('/my/claude', {}, 'darwin', '/Users/a', at()), '/my/claude');
  });

  it('on Windows it looks for claude.exe, with Windows paths', () => {
    const exists = (p: string) => p === 'C:\\Users\\a\\.local\\bin\\claude.exe';
    assert.equal(
      resolveClaude('claude', { Path: 'C:\\Windows;C:\\Tools' }, 'win32', 'C:\\Users\\a', exists),
      'C:\\Users\\a\\.local\\bin\\claude.exe',
    );
    assert.equal(
      resolveClaude('claude', { Path: 'C:\\Tools' }, 'win32', 'C:\\Users\\a', (p) => p === 'C:\\Tools\\claude.exe'),
      'C:\\Tools\\claude.exe',
    );
  });
});

describe('presets', () => {
  it('every preset but custom has a base URL and models; ollama needs no key', () => {
    for (const p of API_PRESETS.filter((p) => p !== 'custom')) {
      assert.match(PRESETS[p].baseUrl, /^https?:\/\//, p);
      assert.ok(PRESETS[p].scoreModel && PRESETS[p].letterModel, p);
    }
    assert.equal(PRESETS.ollama.needsKey, false);
    assert.equal(PRESETS.anthropic.baseUrl, 'https://api.anthropic.com/v1');
    assert.equal(PRESETS.gemini.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
  });

  it('detects the provider from the key prefix', () => {
    assert.equal(detectPreset('sk-ant-api03-x'), 'anthropic');
    assert.equal(detectPreset('gsk_abc'), 'groq');
    assert.equal(detectPreset('sk-or-v1-abc'), 'openrouter');
    assert.equal(detectPreset('AIzaSyabc'), 'gemini');
    assert.equal(detectPreset('sk-proj-abc'), 'openai');
    assert.equal(detectPreset('sk-abc'), 'openai'); // DeepSeek keys look like this too
    assert.equal(detectPreset('xyz'), null);
    assert.equal(detectPreset(''), null);
  });
});

describe('resolveApi', () => {
  it('defaults to the Claude CLI with its own models', () => {
    assert.equal(providerMode(base), 'claude-cli');
    assert.equal(aiModel('score', base), 'haiku');
    assert.equal(aiLabel('letter', base), 'Claude CLI sonnet');
  });

  it('picks the preset from the key, with its URL and models', () => {
    const t = resolveApi(api(), { AI_API_KEY: ANT });
    assert.deepEqual(
      [t.preset, t.name, t.url, t.format, t.keyEnv],
      ['anthropic', 'Anthropic', 'https://api.anthropic.com/v1/chat/completions', 'text', 'AI_API_KEY'],
    );
    assert.deepEqual([t.scoreModel, t.letterModel], [PRESETS.anthropic.scoreModel, PRESETS.anthropic.letterModel]);
    assert.equal(resolveApi(api(), { AI_API_KEY: 'gsk_x' }).url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(aiLabel('score', api(), { AI_API_KEY: 'AIzaX' }), 'Gemini gemini-2.5-flash');
  });

  it('an explicit preset wins over the key prefix (DeepSeek keys start with sk-)', () => {
    const t = resolveApi(api({ preset: 'deepseek' }), { AI_API_KEY: 'sk-deepseek' });
    assert.deepEqual([t.preset, t.url, t.format], ['deepseek', 'https://api.deepseek.com/chat/completions', 'json_object']);
  });

  it('a base URL (AI_BASE_URL or ai.api.baseUrl) wins over the key prefix, as a custom endpoint', () => {
    const t = resolveApi(api(), { AI_API_KEY: ANT, AI_BASE_URL: 'https://llm.example.test/v1/' });
    assert.deepEqual([t.preset, t.url], ['custom', 'https://llm.example.test/v1/chat/completions']);
    assert.equal(t.scoreModel, PRESETS.anthropic.scoreModel); // models lent by the recognisable key
    assert.equal(
      resolveApi(api({ baseUrl: 'https://cfg.example.test/v1', scoreModel: 'a', letterModel: 'b' }), { AI_API_KEY: 'x' }).preset,
      'custom',
    );
    // With a preset and a base URL, the URL changes and the preset's format stays.
    const both = resolveApi(api({ preset: 'openai', baseUrl: 'https://proxy.example.test/v1' }), { AI_API_KEY: KEY });
    assert.deepEqual([both.url, both.format], ['https://proxy.example.test/v1/chat/completions', 'json_schema']);
  });

  it('models and the response format in config.json override the preset', () => {
    const t = resolveApi(api({ scoreModel: 'gpt-4.1-mini', responseFormat: 'text' }), { AI_API_KEY: KEY });
    assert.deepEqual([t.scoreModel, t.letterModel, t.format], ['gpt-4.1-mini', 'gpt-4o', 'text']);
  });

  it('ollama needs no key', () => {
    const t = resolveApi(api({ preset: 'ollama' }), {});
    assert.deepEqual([t.url, t.key], ['http://localhost:11434/v1/chat/completions', '']);
  });

  it('reads the older provider names and env variables', () => {
    const old = { ...base, provider: 'openai' as const, openai: { letterModel: 'gpt-4.1', baseUrl: 'https://p.example.test' } };
    const openai = resolveApi(old, { OPENAI_API_KEY: KEY });
    assert.deepEqual(
      [openai.preset, openai.url, openai.letterModel, openai.keyEnv],
      ['openai', 'https://p.example.test/v1/chat/completions', 'gpt-4.1', 'OPENAI_API_KEY'],
    );
    const deepseek = resolveApi({ ...base, provider: 'deepseek' }, { DEEPSEEK_API_KEY: KEY, OPENAI_API_KEY: 'sk-other' });
    assert.deepEqual([deepseek.preset, deepseek.key, deepseek.keyEnv], ['deepseek', KEY, 'DEEPSEEK_API_KEY']);
    // With "api" and only an old key, that key says which provider it is for.
    assert.equal(resolveApi(api(), { DEEPSEEK_API_KEY: KEY }).preset, 'deepseek');
    assert.equal(resolveApi(api(), { AI_API_KEY: ANT, OPENAI_API_KEY: KEY }).preset, 'anthropic'); // AI_API_KEY first
  });

  it('explains what is missing, naming AI_API_KEY and never a key', () => {
    assert.throws(() => resolveApi(api(), {}), /No AI API key: set AI_API_KEY in \.env/);
    assert.throws(
      () => resolveApi(api(), { AI_API_KEY: 'weird-key-123' }),
      (e: Error) => {
        assert.match(e.message, /AI_API_KEY does not look like a key of a known provider: set ai\.api\.preset/);
        assert.ok(!e.message.includes('weird-key-123'));
        return true;
      },
    );
    assert.throws(() => resolveApi(api({ preset: 'anthropic' }), {}), /Anthropic needs an API key: set AI_API_KEY/);
    assert.throws(() => resolveApi(api({ preset: 'custom' }), { AI_API_KEY: 'x' }), /needs a base URL: set AI_BASE_URL/);
    assert.throws(() => resolveApi(api({ preset: 'custom', baseUrl: 'http://h.test' }), {}), /needs models/);
    assert.equal(aiLabel('score', api(), {}), 'the API provider (not set up yet)');
  });
});

describe('response formats', () => {
  const req = { prompt: 'p', schema: SCHEMA, kind: 'score' as const, system: 'sys' };
  const system = (b: Record<string, unknown>) => (b.messages as { content: string }[])[0].content;

  it('json_schema: the provider enforces the schema, the prompt is unchanged', () => {
    const b = chatBody({ format: 'json_schema', temperature: true }, req, 'm');
    assert.deepEqual(b.response_format, { type: 'json_schema', json_schema: { name: 'job_bot_score', schema: SCHEMA, strict: false } });
    assert.equal(system(b), 'sys');
    assert.equal(b.temperature, 0.2);
  });

  it('json_object: JSON mode plus the schema in the system prompt', () => {
    const b = chatBody({ format: 'json_object', temperature: true }, req, 'm');
    assert.deepEqual(b.response_format, { type: 'json_object' });
    assert.match(system(b), /^sys\n\nReply with one JSON object only/);
  });

  it('text: no response_format, the schema in the prompt, and no temperature where it is rejected', () => {
    const b = chatBody({ format: 'text', temperature: false }, req, 'm');
    assert.equal('response_format' in b, false);
    assert.equal('temperature' in b, false);
    assert.ok(system(b).includes(JSON.stringify(SCHEMA)));
  });
});

describe('askAi over HTTP', () => {
  it('OpenAI key: posts Chat Completions with the key, model and json_schema', async () => {
    const seen = serve(reply('{"score":80,"verdict":"good"}'));
    assert.deepEqual(await askAi('the job', SCHEMA, 'score', 'be a recruiter', api()), { score: 80, verdict: 'good' });
    const [{ url, headers, body }] = seen;
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(headers.authorization, `Bearer ${KEY}`);
    assert.equal(body.model, 'gpt-4o-mini');
    assert.equal(body.response_format.type, 'json_schema');
    assert.ok(body.temperature <= 0.3, 'scoring runs at a low temperature');
  });

  it('Anthropic key: the compatibility endpoint in text mode with the letter model', async () => {
    process.env.AI_API_KEY = ANT;
    const seen = serve(reply('```json\n{"letter":"Dear"}\n```'));
    assert.deepEqual(await askAi('cv', { type: 'object', required: ['letter'] }, 'letter', 's', api()), { letter: 'Dear' });
    assert.equal(seen[0].url, 'https://api.anthropic.com/v1/chat/completions');
    assert.equal(seen[0].headers.authorization, `Bearer ${ANT}`);
    assert.equal(seen[0].body.model, PRESETS.anthropic.letterModel);
    assert.equal('response_format' in seen[0].body, false);
    assert.equal('temperature' in seen[0].body, false);
  });

  it('DeepSeek preset: json_object with the schema in the system prompt', async () => {
    const seen = serve(reply('{"score":90,"verdict":"strong"}'));
    await askAi('the job', SCHEMA, 'score', 'be a recruiter', api({ preset: 'deepseek' }));
    assert.equal(seen[0].url, 'https://api.deepseek.com/chat/completions');
    assert.deepEqual(seen[0].body.response_format, { type: 'json_object' });
    assert.ok(seen[0].body.messages[0].content.includes(JSON.stringify(SCHEMA)));
  });

  it('ollama: no key and no authorization header', async () => {
    delete process.env.AI_API_KEY;
    const seen = serve(reply('{"score":1,"verdict":"poor"}'));
    await askAi('p', SCHEMA, 'score', 's', api({ preset: 'ollama' }));
    assert.equal(seen[0].url, 'http://localhost:11434/v1/chat/completions');
    assert.equal(seen[0].headers.authorization, undefined);
  });

  it('the older "openai" provider with OPENAI_API_KEY still works', async () => {
    delete process.env.AI_API_KEY;
    process.env.OPENAI_API_KEY = KEY;
    const seen = serve(reply('{"score":2,"verdict":"poor"}'));
    await askAi('p', SCHEMA, 'score', 's', { ...base, provider: 'openai' });
    assert.equal(seen[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(seen[0].headers.authorization, `Bearer ${KEY}`);
  });

  it('asks once more when the reply is not valid JSON, then fails naming what was wrong', async () => {
    let seen = serve(reply('Sure! Here is the review'), reply('{"score":70,"verdict":"good"}'));
    assert.deepEqual(await askAi('p', SCHEMA, 'score', 's', api()), { score: 70, verdict: 'good' });
    assert.equal(seen.length, 2);
    mock!.restore();
    seen = serve(reply('{"score":70}'), reply('{"score":71}'));
    await assert.rejects(askAi('p', SCHEMA, 'score', 's', api()), /OpenAI gave no usable answer after 2 tries: reply is missing verdict/);
    assert.equal(seen.length, 2);
  });

  it('the re-ask tells the model what was wrong with its previous reply', async () => {
    const seen = serve(reply('Sure! Here is the review'), reply('{"score":70,"verdict":"good"}'));
    assert.deepEqual(await askAi('p', SCHEMA, 'score', 's', api()), { score: 70, verdict: 'good' });
    assert.equal(seen[0].body.messages.length, 2, 'the first request carries no hint');
    const messages = seen[1].body.messages as { role: string; content: string }[];
    assert.equal(messages.length, 3);
    assert.equal(messages[2].role, 'user');
    assert.match(messages[2].content, /previous reply was not valid: reply is not valid JSON/);
    assert.match(messages[2].content, /only one JSON object/);
  });

  it('asks once more when a field has the wrong type, and the retry hint names it', async () => {
    const seen = serve(reply('{"score":"high","verdict":"good"}'), reply('{"score":70,"verdict":"good"}'));
    assert.deepEqual(await askAi('p', SCHEMA, 'score', 's', api()), { score: 70, verdict: 'good' });
    assert.equal(seen.length, 2);
    assert.match((seen[1].body.messages as { content: string }[])[2].content, /score/);
  });

  it('stops asking when the overall AI budget is exhausted, naming the budget and never the key', async () => {
    const saved = AI_BUDGET.ms;
    AI_BUDGET.ms = 50;
    try {
      mock = mockFetch({ 'chat/completions': () => new Promise<never>(() => {}) }); // a request that never answers
      await assert.rejects(askAi('p', SCHEMA, 'score', 's', api()), (e: Error) => {
        assert.match(e.message, /OpenAI gave no answer within the [\d.]+s AI budget/);
        return noKeyIn(e);
      });
      assert.equal(mock.calls.length, 1, 'no retry once the budget is spent');
    } finally {
      AI_BUDGET.ms = saved;
    }
  });

  it('the budget aborts the request in flight (fetch sees the signal), so nothing keeps the process alive', async () => {
    const saved = AI_BUDGET.ms;
    AI_BUDGET.ms = 50;
    let aborted = false;
    try {
      mock = mockFetch({
        // Never answers on its own; rejects when its signal aborts, like a real fetch.
        'chat/completions': (_u: string, init?: RequestInit) =>
          new Promise((_, reject) =>
            init!.signal!.addEventListener('abort', () => {
              aborted = true;
              reject(init!.signal!.reason);
            }),
          ),
      });
      const timers = liveTimers();
      const start = Date.now();
      await assert.rejects(askAi('p', SCHEMA, 'score', 's', api()), (e: Error) => {
        assert.ok(e instanceof AiError);
        assert.match(e.message, /OpenAI gave no answer within the 0\.05s AI budget/);
        assert.deepEqual([e.timedOut, e.fatal], [true, false]);
        return noKeyIn(e);
      });
      assert.ok(Date.now() - start < 2000, 'settled right after the budget');
      assert.equal(aborted, true, 'the fetch itself was aborted');
      assert.equal(liveTimers(), timers, 'no budget timer left behind');
      assert.equal(mock.calls.length, 1);
    } finally {
      AI_BUDGET.ms = saved;
    }
  });

  it('the budget also cuts a retry backoff short: no further request once it is spent', async () => {
    const saved = AI_BUDGET.ms;
    AI_BUDGET.ms = 100;
    timing.scale = 1; // a real backoff (about 1 s) after the 503
    try {
      const seen = serve(new Response('busy', { status: 503 }), reply('{"score":1,"verdict":"poor"}'));
      const timers = liveTimers();
      const start = Date.now();
      await assert.rejects(askAi('p', SCHEMA, 'score', 's', api()), (e: AiError) => e.timedOut && /AI budget/.test(e.message));
      assert.ok(Date.now() - start < 600, `settled after ${Date.now() - start} ms, not after the backoff`);
      assert.equal(liveTimers(), timers, 'the backoff timer was cleared, nothing holds the process open');
      assert.equal(seen.length, 1);
    } finally {
      AI_BUDGET.ms = saved;
    }
  });

  it('marks errors that would repeat for every call as fatal, and a bad reply as not', async () => {
    const fatal = async (p: Promise<unknown>) => {
      const e = (await p.catch((x) => x)) as AiError;
      assert.ok(e instanceof AiError, String(e));
      return e.fatal;
    };
    for (const status of [401, 403, 402, 404]) {
      serve(Response.json({ error: { message: 'nope' } }, { status }));
      assert.equal(await fatal(askAi('p', SCHEMA, 'score', 's', api())), true, String(status));
      mock!.restore();
    }
    delete process.env.AI_API_KEY;
    assert.equal(await fatal(askAi('p', SCHEMA, 'score', 's', api())), true, 'no key');
    assert.equal(await fatal(askAi('p', SCHEMA, 'score', 's', api({ preset: 'custom' }))), true, 'no base URL');
    process.env.AI_API_KEY = KEY;
    serve(reply('not json'), reply('still not json'));
    const bad = (await askAi('p', SCHEMA, 'score', 's', api()).catch((x) => x)) as AiError;
    assert.match(bad.message, /no usable answer after 2 tries/);
    assert.deepEqual([bad.fatal, bad.timedOut], [false, false]);
    mock!.restore();
    serve(new Response('busy', { status: 500 }));
    assert.equal(await fatal(askAi('p', SCHEMA, 'score', 's', api())), false, 'a server error may pass');
  });

  it('fails fast on 401/403 naming AI_API_KEY and the detected provider, never the key', async () => {
    process.env.AI_API_KEY = ANT;
    for (const status of [401, 403]) {
      const seen = serve(Response.json({ error: { message: `invalid x-api-key ${ANT}` } }, { status }));
      await assert.rejects(askAi('p', SCHEMA, 'score', 's', api()), (e: Error) => {
        assert.match(
          e.message,
          new RegExp(`Anthropic rejected the API key \\(AI_API_KEY\\): ${status} \\(invalid x-api-key \\*\\*\\*\\)\\.`),
        );
        assert.match(e.message, /Make a new key at https:\/\/console\.anthropic\.com\/settings\/keys and put it in \.env/);
        assert.match(e.message, /only the key, with no quotes, spaces or notes\. Then restart the dashboard\.$/);
        assert.equal(e.name, 'AiError');
        return noKeyIn(e);
      });
      assert.equal(seen.length, 1, 'not retried');
      mock!.restore();
    }
  });

  it('says the account has no credit on 402, with where to add it', async () => {
    process.env.AI_API_KEY = 'sk-' + 'a'.repeat(32);
    const seen = serve(Response.json({ error: { message: 'Insufficient Balance' } }, { status: 402 }));
    await assert.rejects(askAi('p', SCHEMA, 'score', 's', api({ preset: 'deepseek' })), (e: Error) => {
      assert.equal(
        e.message,
        'DeepSeek says the account has no credit left (402). Add credit at https://platform.deepseek.com/top_up, or choose another AI on the Settings page.',
      );
      return true;
    });
    assert.equal(seen.length, 1);
  });

  it('names no page for a provider it has none for, and leaves out an empty provider message', () => {
    const t = { preset: 'custom' as const, name: 'Custom endpoint', keyEnv: 'AI_API_KEY' };
    assert.equal(
      keyRejected(t, 401),
      'Custom endpoint rejected the API key (AI_API_KEY): 401. Make a new key and put it in .env in the job-bot folder as ' +
        'AI_API_KEY=<the key>: only the key, with no quotes, spaces or notes. Then restart the dashboard.',
    );
    assert.match(noCredit(t), /Add credit in your account,/);
  });

  it('redacts the key from other API errors and reports the provider message', async () => {
    serve(Response.json({ error: { message: `model not found for ${KEY}` } }, { status: 404 }));
    await assert.rejects(askAi('p', SCHEMA, 'score', 's', api()), (e: Error) => {
      assert.match(e.message, /OpenAI request failed: 404 model not found/);
      return noKeyIn(e);
    });
  });

  it('retries a 5xx before giving up', async () => {
    const seen = serve(new Response('busy', { status: 503 }), reply('{"score":1,"verdict":"poor"}'));
    assert.deepEqual(await askAi('p', SCHEMA, 'score', 's', api()), { score: 1, verdict: 'poor' });
    assert.equal(seen.length, 2);
  });

  it('a missing key is a clear error before any request', async () => {
    delete process.env.AI_API_KEY;
    const seen = serve(reply('{}'));
    await assert.rejects(askAi('p', SCHEMA, 'score', 's', api()), /No AI API key: set AI_API_KEY/);
    await assert.rejects(askAi('p', SCHEMA, 'score', 's', api({ preset: 'groq' })), /Groq needs an API key: set AI_API_KEY/);
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

  // The shapes the code reads and stores, like src/ai.ts SCORE_SCHEMA declares them.
  const DEEP = {
    type: 'object',
    properties: {
      score: { type: 'integer', minimum: 0, maximum: 100 },
      verdict: { type: 'string', enum: ['good', 'poor'] },
      reasons: { type: 'array', items: { type: 'string' } },
      location: {
        type: 'object',
        properties: { eligible: { type: 'string', enum: ['yes', 'no', 'unclear'] }, reason: { type: 'string' } },
        required: ['eligible', 'reason'],
      },
    },
    required: ['score', 'verdict'],
  };
  const deep = (json: object) => parseReply(reply(JSON.stringify({ score: 70, verdict: 'good', ...json })), DEEP);

  it('rejects wrong types, out-of-range numbers and values outside the enum', () => {
    assert.throws(() => deep({ verdict: 42 }), /reply does not match the schema at verdict/);
    assert.throws(() => deep({ verdict: 'awesome' }), /verdict/);
    assert.throws(() => deep({ score: 'high' }), /score/);
    assert.throws(() => deep({ score: 101 }), /score/);
    assert.throws(() => deep({ reasons: 'solid fit' }), /reasons/);
    assert.throws(() => deep({ reasons: [42] }), /reasons/);
  });

  it('rejects a wrong nested shape, naming the path', () => {
    assert.throws(() => deep({ location: 'Berlin' }), /reply does not match the schema at location/);
    assert.throws(() => deep({ location: { eligible: 'maybe', reason: 'r' } }), /location\.eligible/);
    assert.throws(() => deep({ location: { eligible: 'yes' } }), /location\.reason/);
  });

  it('a valid reply still parses, keeping keys the schema does not know', () => {
    assert.deepEqual(deep({ location: { eligible: 'yes', reason: 'visa provided' }, extra: true }), {
      score: 70,
      verdict: 'good',
      location: { eligible: 'yes', reason: 'visa provided' },
      extra: true,
    });
    // A schema with required keys but no properties (src/ai.ts textSchema's simplest shape) checks presence only.
    assert.deepEqual(parseReply(reply('{"letter":"Dear"}'), { type: 'object', required: ['letter'] }), { letter: 'Dear' });
  });
});
