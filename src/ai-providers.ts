import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { AI_BASE_URL_ENV, AI_KEY_ENV, LEGACY_KEY_ENV, PRESETS, detectPreset, type ApiPreset, type ResponseFormat } from './ai-presets.ts';
import { config } from './config.ts';
import type { AiSettings } from './settings.ts';
import { HttpError, postJson } from './sources/http.ts';

// The AI behind every AI feature (src/ai.ts). `config.json` → `ai.provider` picks one:
// - "claude-cli" (default): the locally signed-in Claude Code CLI (`claude -p`), no API key, usage from the Claude plan.
// - "api": any OpenAI-compatible chat API with one key, AI_API_KEY in .env, paid per token. The preset (OpenAI,
//   Anthropic, Gemini, ...; src/ai-presets.ts) comes from ai.api.preset, else "custom" when a base URL is set, else
//   the key's prefix. The key is only ever sent to that base URL and never logged or put in an error message.
//   "openai" / "deepseek" (and OPENAI_API_KEY / DEEPSEEK_API_KEY) are the older names, still read.

export type AiKind = 'score' | 'letter';
export type ProviderMode = 'claude-cli' | 'api';

/** Every call, whichever provider: the same budget as the CLI path has always had. */
export const AI_TIMEOUT_MS = 180_000;

export const providerMode = (ai: AiSettings = config.ai): ProviderMode =>
  !ai.provider || ai.provider === 'claude-cli' ? 'claude-cli' : 'api';

/** Where an API call goes and how; never contains the key itself except in `key`, which only goes into the header. */
export type ApiTarget = {
  preset: ApiPreset;
  name: string; // "Anthropic", "Custom endpoint", ...
  url: string; // .../chat/completions
  scoreModel: string;
  letterModel: string;
  format: ResponseFormat;
  temperature: boolean;
  key: string; // '' when none is needed
  keyEnv: string; // AI_API_KEY, or the older name it came from
};

type Env = Record<string, string | undefined>;

/** The API target from config.json ai and the environment; throws a clear error naming AI_API_KEY when it cannot. */
export function resolveApi(ai: AiSettings = config.ai, env: Env = process.env): ApiTarget {
  const legacy = ai.provider === 'openai' || ai.provider === 'deepseek' ? ai.provider : undefined;
  const cfg = ai.api ?? {};
  const old = legacy ? (ai[legacy] ?? {}) : {};
  const explicit: ApiPreset | undefined = cfg.preset ?? legacy;

  // One key, AI_API_KEY; the older per-provider names are fallbacks that also say which provider they are for.
  let key = env[AI_KEY_ENV]?.trim() ?? '';
  let keyEnv = AI_KEY_ENV;
  let keyPreset: ApiPreset | null = null;
  if (!key) {
    const order: ('openai' | 'deepseek')[] = explicit === 'deepseek' ? ['deepseek', 'openai'] : ['openai', 'deepseek'];
    const found = order.find((p) => env[LEGACY_KEY_ENV[p]]?.trim());
    if (found) {
      key = env[LEGACY_KEY_ENV[found]]!.trim();
      keyEnv = LEGACY_KEY_ENV[found];
      keyPreset = found;
    }
  }
  const detected = keyPreset ?? detectPreset(key);

  const oldBase = old.baseUrl ? old.baseUrl.replace(/\/+$/, '') + (legacy === 'openai' ? '/v1' : '') : '';
  const baseOverride = env[AI_BASE_URL_ENV]?.trim() || cfg.baseUrl || oldBase;
  // An explicit preset or a base URL always wins over what the key looks like.
  const preset: ApiPreset | null = explicit ?? (baseOverride ? 'custom' : detected);
  if (!preset) {
    throw new Error(
      key
        ? `${AI_KEY_ENV} does not look like a key of a known provider: set ai.api.preset in config.json (or ${AI_BASE_URL_ENV} in .env)`
        : `No AI API key: set ${AI_KEY_ENV} in .env (in the job-bot folder), or set ai.provider to "claude-cli" in config.json`,
    );
  }
  const p = PRESETS[preset];
  // A custom endpoint has no models of its own; a recognisable key lends its provider's defaults.
  const fallback = preset === 'custom' && detected ? PRESETS[detected] : p;
  const scoreModel = cfg.scoreModel || old.scoreModel || p.scoreModel || fallback.scoreModel;
  const letterModel = cfg.letterModel || old.letterModel || p.letterModel || fallback.letterModel;
  const base = (baseOverride || p.baseUrl).replace(/\/+$/, '');
  if (!base) throw new Error(`${p.name} needs a base URL: set ${AI_BASE_URL_ENV} in .env or ai.api.baseUrl in config.json`);
  if (!scoreModel || !letterModel) throw new Error(`${p.name} needs models: set ai.api.scoreModel and ai.api.letterModel in config.json`);
  if (p.needsKey && !key) {
    throw new Error(`${p.name} needs an API key: set ${AI_KEY_ENV} in .env (in the job-bot folder), or set ai.provider to "claude-cli"`);
  }
  return {
    preset,
    name: p.name,
    url: `${base}/chat/completions`,
    scoreModel,
    letterModel,
    format: cfg.responseFormat ?? p.format,
    temperature: p.temperature,
    key,
    keyEnv,
  };
}

/** The model for this kind of call: the Claude CLI's `ai.scoreModel` / `letterModel`, or the API target's. */
export function aiModel(kind: AiKind, ai: AiSettings = config.ai, env: Env = process.env): string {
  if (providerMode(ai) === 'claude-cli') return kind === 'score' ? ai.scoreModel : ai.letterModel;
  const t = resolveApi(ai, env);
  return kind === 'score' ? t.scoreModel : t.letterModel;
}

/** "Anthropic claude-haiku-5-5" / "Claude CLI haiku", for progress lines. Never throws: errors come with the call. */
export function aiLabel(kind: AiKind, ai: AiSettings = config.ai, env: Env = process.env): string {
  if (providerMode(ai) === 'claude-cli') return `Claude CLI ${aiModel(kind, ai)}`;
  try {
    const t = resolveApi(ai, env);
    return `${t.name} ${kind === 'score' ? t.scoreModel : t.letterModel}`;
  } catch {
    return 'the API provider (not set up yet)';
  }
}

/**
 * The one entry point for every AI feature: sends the prompt to the configured provider and returns the JSON object
 * that matches `schema`. `kind` picks the model (fast scoring or the better writer).
 */
export function askAi<T>(prompt: string, schema: object, kind: AiKind, system: string, ai: AiSettings = config.ai): Promise<T> {
  if (providerMode(ai) === 'claude-cli') return askClaude<T>(prompt, schema, aiModel(kind, ai), system, ai.claudePath);
  return askApi<T>({ prompt, schema, kind, system }, ai);
}

// ---- Claude Code CLI ----

/**
 * The Claude CLI to run. A bare name ("claude", the default) is looked up on PATH, then in ~/.local/bin, where the
 * Claude CLI installs itself: a dashboard or scheduler started without that folder on PATH still finds it.
 * A path is used as given.
 */
export function resolveClaude(
  claudePath = 'claude',
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
  exists: (p: string) => boolean = existsSync,
): string {
  if (/[\\/]/.test(claudePath)) return claudePath;
  const names = platform === 'win32' ? [`${claudePath}.exe`, claudePath] : [claudePath];
  const dirs = [...(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean), join(home, '.local', 'bin')];
  for (const dir of dirs) for (const name of names) if (exists(join(dir, name))) return join(dir, name);
  return claudePath;
}

// JOB_BOT_CLAUDE swaps in another executable (tests use a fake one). Calls are headless: no tools, no MCP servers,
// no session saved.
export function askClaude<T>(prompt: string, schema: object, model: string, system: string, claudePath = config.ai.claudePath): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.JOB_BOT_CLAUDE || resolveClaude(claudePath),
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
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
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

// ---- OpenAI-compatible chat APIs ----

type ApiRequest = { prompt: string; schema: object; kind: AiKind; system: string };
type ChatReply = { choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[] };

/** Why a reply is unusable; such a reply is asked for once more before failing. */
class BadReply extends Error {}

const redact = (s: string, key: string) => (key ? s.split(key).join('***') : s);

/** The request body for the target's response format; without json_schema the schema goes into the system prompt. */
export function chatBody(t: Pick<ApiTarget, 'format' | 'temperature'>, req: ApiRequest, model: string): Record<string, unknown> {
  const system =
    t.format === 'json_schema'
      ? req.system
      : `${req.system}\n\nReply with one JSON object only, no other text and no markdown, that matches this JSON schema:\n${JSON.stringify(req.schema)}`;
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: req.prompt },
    ],
  };
  if (t.format === 'json_schema') {
    body.response_format = { type: 'json_schema', json_schema: { name: `job_bot_${req.kind}`, schema: req.schema, strict: false } };
  } else if (t.format === 'json_object') body.response_format = { type: 'json_object' };
  // Scoring should be repeatable; writing may vary a little.
  if (t.temperature) body.temperature = req.kind === 'score' ? 0.2 : 0.7;
  return body;
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

/** A provider's error message from its JSON error body ({ error: { message } }, or a list of those), shortened. */
function apiMessage(body: string): string {
  try {
    const j = JSON.parse(body);
    const m = (Array.isArray(j) ? j[0] : j)?.error?.message;
    if (typeof m === 'string' && m) return m.slice(0, 300);
  } catch {}
  return body.slice(0, 200);
}

export async function askApi<T>(req: ApiRequest, ai: AiSettings = config.ai, env: Env = process.env): Promise<T> {
  const t = resolveApi(ai, env);
  const body = chatBody(t, req, req.kind === 'score' ? t.scoreModel : t.letterModel);
  const headers: Record<string, string> = t.key ? { authorization: `Bearer ${t.key}` } : {};
  let last = '';
  // One more try when the reply is not the JSON asked for; HTTP retries (429, 5xx) happen inside postJson.
  for (let attempt = 0; attempt < 2; attempt++) {
    let reply: ChatReply;
    try {
      reply = await postJson<ChatReply>(t.url, body, { headers, attempts: 3, timeoutMs: AI_TIMEOUT_MS });
    } catch (e) {
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
        throw new Error(`${t.name} rejected the API key (${t.keyEnv}): ${e.status}`);
      }
      const detail = e instanceof HttpError ? `${e.status} ${apiMessage(e.body)}` : (e as Error).message;
      throw new Error(redact(`${t.name} request failed: ${detail}`, t.key));
    }
    try {
      return parseReply<T>(reply, req.schema);
    } catch (e) {
      if (!(e instanceof BadReply)) throw new Error(redact(`${t.name}: ${(e as Error).message}`, t.key));
      last = e.message;
    }
  }
  throw new Error(redact(`${t.name} gave no usable answer after 2 tries: ${last}`, t.key));
}
