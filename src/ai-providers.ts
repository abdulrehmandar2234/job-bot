import { spawn } from 'node:child_process';
import { config } from './config.ts';
import { API_DEFAULTS, KEY_ENV, PROVIDER_NAME, type AiProvider, type AiSettings } from './settings.ts';
import { HttpError, postJson } from './sources/http.ts';

// The AI providers behind every AI feature (src/ai.ts). `config.json` → `ai.provider` picks one:
// - "claude-cli" (default): the locally signed-in Claude Code CLI (`claude -p`), no API key, usage from the Claude plan.
// - "openai" / "deepseek": their HTTP chat APIs with an API key from the environment (OPENAI_API_KEY / DEEPSEEK_API_KEY
//   in .env), paid per token. The key is only ever sent to that provider's base URL and never logged or put in an error.

export type AiKind = 'score' | 'letter';
export type ApiProvider = Exclude<AiProvider, 'claude-cli'>;

/** Every call, whichever provider: the same budget as the CLI path has always had. */
export const AI_TIMEOUT_MS = 180_000;

export { API_DEFAULTS, KEY_ENV, PROVIDER_NAME };

export const aiProvider = (ai: AiSettings = config.ai): AiProvider => ai.provider ?? 'claude-cli';

/** The model for this kind of call: the Claude CLI's `ai.scoreModel` / `letterModel`, or the API provider's own. */
export function aiModel(kind: AiKind, ai: AiSettings = config.ai): string {
  const provider = aiProvider(ai);
  if (provider === 'claude-cli') return kind === 'score' ? ai.scoreModel : ai.letterModel;
  const own = ai[provider] ?? {};
  return (kind === 'score' ? own.scoreModel : own.letterModel) || API_DEFAULTS[provider][`${kind}Model`];
}

/** "OpenAI gpt-4o-mini" / "Claude CLI haiku", for progress lines. */
export const aiLabel = (kind: AiKind, ai: AiSettings = config.ai) => `${PROVIDER_NAME[aiProvider(ai)]} ${aiModel(kind, ai)}`;

/**
 * The one entry point for every AI feature: sends the prompt to the configured provider and returns the JSON object
 * that matches `schema`. `kind` picks the model (fast scoring or the better writer).
 */
export function askAi<T>(prompt: string, schema: object, kind: AiKind, system: string, ai: AiSettings = config.ai): Promise<T> {
  const provider = aiProvider(ai);
  if (provider === 'claude-cli') return askClaude<T>(prompt, schema, aiModel(kind, ai), system, ai.claudePath);
  return askApi<T>(provider, { prompt, schema, kind, system }, ai);
}

// ---- Claude Code CLI ----

// JOB_BOT_CLAUDE swaps in another executable (tests use a fake one). Calls are headless: no tools, no MCP servers,
// no session saved.
export function askClaude<T>(prompt: string, schema: object, model: string, system: string, claudePath = config.ai.claudePath): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.JOB_BOT_CLAUDE || claudePath,
      [
        '-p',
        '--model',
        model,
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify(schema),
        '--system-prompt',
        system,
        '--tools',
        '',
        '--strict-mcp-config',
        '--setting-sources',
        '',
        '--no-session-persistence',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Claude CLI timed out'));
    }, AI_TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const res = JSON.parse(out);
        if (res.is_error || !res.structured_output) throw new Error(res.result || `claude exited ${code}`);
        resolve(res.structured_output as T);
      } catch (e) {
        reject(new Error(`${(e as Error).message} ${err.slice(0, 300)}`.trim()));
      }
    });
    child.stdin.end(prompt);
  });
}

// ---- OpenAI and DeepSeek (OpenAI-compatible Chat Completions) ----

type ApiRequest = { prompt: string; schema: object; kind: AiKind; system: string };
type ChatReply = { choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[] };

/** Why a reply is unusable; such a reply is asked for once more before failing. */
class BadReply extends Error {}

const redact = (s: string, key: string) => (key ? s.split(key).join('***') : s);

function apiKey(provider: ApiProvider): string {
  const key = process.env[KEY_ENV[provider]]?.trim();
  if (!key) {
    throw new Error(
      `${PROVIDER_NAME[provider]} needs an API key: set ${KEY_ENV[provider]} in .env (in the job-bot folder), or pick another ai.provider in config.json`,
    );
  }
  return key;
}

/** The request body. DeepSeek only knows `json_object`, so the schema goes into the system prompt. */
export function chatBody(provider: ApiProvider, req: ApiRequest, model: string): Record<string, unknown> {
  const system =
    provider === 'openai'
      ? req.system
      : `${req.system}\n\nReply with one JSON object only, no other text and no markdown, that matches this JSON schema:\n${JSON.stringify(req.schema)}`;
  return {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: req.prompt },
    ],
    response_format:
      provider === 'openai'
        ? { type: 'json_schema', json_schema: { name: `job_bot_${req.kind}`, schema: req.schema, strict: false } }
        : { type: 'json_object' },
    // Scoring should be repeatable; writing may vary a little.
    temperature: req.kind === 'score' ? 0.2 : 0.7,
  };
}

/** The JSON object in a reply, checked for the schema's required top-level keys. */
export function parseReply<T>(reply: ChatReply, schema: object): T {
  const msg = reply.choices?.[0]?.message;
  if (msg?.refusal) throw new Error(`the model refused: ${msg.refusal.slice(0, 200)}`);
  const content = (msg?.content ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  if (!content) throw new BadReply(`empty reply${reply.choices?.[0]?.finish_reason ? ` (${reply.choices[0].finish_reason})` : ''}`);
  let obj: unknown;
  try {
    obj = JSON.parse(content);
  } catch {
    throw new BadReply(`reply is not valid JSON: ${content.slice(0, 120)}`);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new BadReply('reply is not a JSON object');
  const required = (schema as { required?: string[] }).required ?? [];
  const missing = required.filter((k) => !(k in obj));
  if (missing.length) throw new BadReply(`reply is missing ${missing.join(', ')}`);
  return obj as T;
}

/** A provider's error message from its JSON error body ({ error: { message } }), shortened. */
function apiMessage(body: string): string {
  try {
    const m = JSON.parse(body)?.error?.message;
    if (typeof m === 'string' && m) return m.slice(0, 300);
  } catch {}
  return body.slice(0, 200);
}

export async function askApi<T>(provider: ApiProvider, req: ApiRequest, ai: AiSettings = config.ai): Promise<T> {
  const name = PROVIDER_NAME[provider];
  const key = apiKey(provider);
  const base = (ai[provider]?.baseUrl || API_DEFAULTS[provider].baseUrl).replace(/\/+$/, '');
  const url = provider === 'openai' ? `${base}/v1/chat/completions` : `${base}/chat/completions`;
  const body = chatBody(provider, req, aiModel(req.kind, ai));
  let last = '';
  // One more try when the reply is not the JSON asked for; HTTP retries (429, 5xx) happen inside postJson.
  for (let attempt = 0; attempt < 2; attempt++) {
    let reply: ChatReply;
    try {
      reply = await postJson<ChatReply>(url, body, {
        headers: { authorization: `Bearer ${key}` },
        attempts: 3,
        timeoutMs: AI_TIMEOUT_MS,
      });
    } catch (e) {
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
        throw new Error(`${name} rejected the API key (${KEY_ENV[provider]}): ${e.status}`);
      }
      const detail = e instanceof HttpError ? `${e.status} ${apiMessage(e.body)}` : (e as Error).message;
      throw new Error(redact(`${name} request failed: ${detail}`, key));
    }
    try {
      return parseReply<T>(reply, req.schema);
    } catch (e) {
      if (!(e instanceof BadReply)) throw new Error(redact(`${name}: ${(e as Error).message}`, key));
      last = e.message;
    }
  }
  throw new Error(redact(`${name} gave no usable answer after 2 tries: ${last}`, key));
}
