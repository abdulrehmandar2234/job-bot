import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { z } from 'zod';
import { AI_BASE_URL_ENV, AI_KEY_ENV, LEGACY_KEY_ENV, PRESETS, detectPreset, type ApiPreset, type ResponseFormat } from './ai-presets.ts';
import { config } from './config.ts';
import { UserError } from './errors.ts';
import type { AiSettings } from './settings.ts';
import { HttpError, postJson } from './sources/http.ts';

// The AI behind every AI feature (src/ai.ts). `config.json` → `ai.provider` picks one:
// - "claude-cli" (default): the locally signed-in Claude Code CLI (`claude -p`), no API key, usage from the Claude plan.
// - "api": any OpenAI-compatible chat API with one key, AI_API_KEY in .env, paid per token. The preset (OpenAI,
//   Anthropic, Gemini, ...; src/ai-presets.ts) comes from ai.api.preset, else "custom" when a base URL is set, else
//   the key's prefix. The key is only ever sent to that base URL and never logged or put in an error message.
//   "openai" / "deepseek" (and OPENAI_API_KEY / DEEPSEEK_API_KEY) are the older names, still read.

export type AiKind = 'score' | 'letter';

/**
 * An AI call that failed for a reason the user can fix (a rejected key, no credit, no key, a bad setting). The CLI
 * prints only its message, never a stack trace, so the dashboard shows that message as the task's error.
 * `fatal`: the same error will come back for every call until the user acts (key rejected, no credit, no key or a
 * missing setting, the Claude CLI missing or signed out), so a batch (ai:score) stops at the first one.
 * `timedOut`: the provider gave no answer in time; a batch stops after a few of these in a row.
 */
export class AiError extends UserError {
  override name = 'AiError';
  readonly fatal: boolean;
  readonly timedOut: boolean;
  constructor(message: string, opts: { fatal?: boolean; timedOut?: boolean } = {}) {
    super(message);
    this.fatal = opts.fatal ?? false;
    this.timedOut = opts.timedOut ?? false;
  }
}

/** Where each provider's keys and credit are managed, for the messages of a rejected key (401/403) or no credit (402). */
export const ACCOUNT_PAGES: Partial<Record<ApiPreset, { keys: string; billing?: string }>> = {
  openai: { keys: 'https://platform.openai.com/api-keys', billing: 'https://platform.openai.com/settings/organization/billing' },
  deepseek: { keys: 'https://platform.deepseek.com/api_keys', billing: 'https://platform.deepseek.com/top_up' },
  anthropic: { keys: 'https://console.anthropic.com/settings/keys', billing: 'https://console.anthropic.com/settings/billing' },
  gemini: { keys: 'https://aistudio.google.com/apikey' },
  groq: { keys: 'https://console.groq.com/keys' },
  openrouter: { keys: 'https://openrouter.ai/settings/keys', billing: 'https://openrouter.ai/settings/credits' },
  mistral: { keys: 'https://console.mistral.ai/api-keys' },
  together: { keys: 'https://api.together.ai/settings/api-keys' },
};

/** What to do about a key the provider rejected: where to get a new one and how to paste it. */
export function keyRejected(t: Pick<ApiTarget, 'preset' | 'name' | 'keyEnv'>, status: number, detail = ''): string {
  const page = ACCOUNT_PAGES[t.preset]?.keys;
  return (
    `${t.name} rejected the API key (${t.keyEnv}): ${status}${detail ? ` ${detail}` : ''}. ` +
    `Make a new key${page ? ` at ${page}` : ''} and put it in .env in the job-bot folder as ${t.keyEnv}=<the key>: ` +
    'only the key, with no quotes, spaces or notes. Then restart the dashboard.'
  );
}

/** What to do when the provider's account has no credit left (402). */
export function noCredit(t: Pick<ApiTarget, 'preset' | 'name'>): string {
  const page = ACCOUNT_PAGES[t.preset]?.billing;
  return (
    `${t.name} says the account has no credit left (402). Add credit${page ? ` at ${page}` : ' in your account'}, ` +
    'or choose another AI on the Settings page.'
  );
}
export type ProviderMode = 'claude-cli' | 'api';

/** Per attempt: one HTTP request, or the whole CLI run (the CLI path makes one attempt). */
export const AI_TIMEOUT_MS = 180_000;

/**
 * The overall budget for one askAi call, whichever provider: attempts, HTTP retries, backoff and the one re-ask all
 * stop here, so a caller knows it has an answer or the real provider error by then. The task timeouts in src/tasks.ts
 * must exceed this with margin (tests/tasks.test.ts ties them together), or the worker SIGKILLs the task and the user
 * sees a generic "Timed out" instead of what actually went wrong. An object so tests can shrink it.
 */
export const AI_BUDGET = { ms: 300_000 };

/** After a per-attempt timeout, how long the Claude CLI gets to exit on SIGTERM before it is SIGKILLed. */
export const CLI_KILL_GRACE_MS = 3000;

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
    throw new AiError(
      key
        ? `${AI_KEY_ENV} does not look like a key of a known provider: set ai.api.preset in config.json (or ${AI_BASE_URL_ENV} in .env)`
        : `No AI API key: set ${AI_KEY_ENV} in .env (in the job-bot folder), or set ai.provider to "claude-cli" in config.json`,
      { fatal: true },
    );
  }
  const p = PRESETS[preset];
  // A custom endpoint has no models of its own; a recognisable key lends its provider's defaults.
  const fallback = preset === 'custom' && detected ? PRESETS[detected] : p;
  const scoreModel = cfg.scoreModel || old.scoreModel || p.scoreModel || fallback.scoreModel;
  const letterModel = cfg.letterModel || old.letterModel || p.letterModel || fallback.letterModel;
  const base = (baseOverride || p.baseUrl).replace(/\/+$/, '');
  if (!base) {
    throw new AiError(`${p.name} needs a base URL: set ${AI_BASE_URL_ENV} in .env or ai.api.baseUrl in config.json`, { fatal: true });
  }
  if (!scoreModel || !letterModel) {
    throw new AiError(`${p.name} needs models: set ai.api.scoreModel and ai.api.letterModel in config.json`, { fatal: true });
  }
  if (p.needsKey && !key) {
    throw new AiError(`${p.name} needs an API key: set ${AI_KEY_ENV} in .env (in the job-bot folder), or set ai.provider to "claude-cli"`, {
      fatal: true,
    });
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
  // Paths for the target OS (not the one running the tests): win32 joins with "\\" and splits PATH on ";".
  const p = platform === 'win32' ? win32 : posix;
  const names = platform === 'win32' ? [`${claudePath}.exe`, claudePath] : [claudePath];
  const dirs = [...(env.PATH ?? env.Path ?? '').split(p.delimiter).filter(Boolean), p.join(home, '.local', 'bin')];
  for (const dir of dirs) for (const name of names) if (exists(p.join(dir, name))) return p.join(dir, name);
  return claudePath;
}

/** Added to every error the Claude CLI reports itself: the usual cause is a signed-out CLI. */
export const CLAUDE_SIGN_IN_HINT = 'If you are signed out, run `claude` once in a terminal to sign in.';

// What the Claude CLI says when every call will fail until the user acts: signed out, a bad or expired login, or a
// usage limit / no credit. Such an error is fatal (a batch stops at the first one).
const CLAUDE_FATAL = /log ?in|logged (in|out)|sign(ed)? ?(in|out)|auth|api key|credential|oauth|expired|usage limit|credit|billing|quota/i;

// JOB_BOT_CLAUDE swaps in another executable (tests use a fake one). Calls are headless: no tools, no MCP servers,
// no session saved. Every failure is an AiError with what to do about it.
export function askClaude<T>(
  prompt: string,
  schema: object,
  model: string,
  system: string,
  claudePath = config.ai.claudePath,
  timeoutMs = AI_TIMEOUT_MS,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const cmd = process.env.JOB_BOT_CLAUDE || resolveClaude(claudePath);
    const child = spawn(
      cmd,
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
    let hardKill: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      // Polite first; a wedged CLI that ignores SIGTERM is SIGKILLed after a short grace, so it never outlives the
      // rejected promise. Both timers are unref'd or cleared on close, so they never keep the bot alive.
      child.kill();
      hardKill = setTimeout(() => child.kill('SIGKILL'), CLI_KILL_GRACE_MS);
      hardKill.unref();
      reject(new AiError(`Claude CLI gave no answer within ${timeoutMs / 1000}s`, { timedOut: true }));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      clearTimeout(hardKill);
      reject(
        new AiError(
          e.code === 'ENOENT'
            ? `Claude CLI not found at ${cmd}: install Claude Code, or set ai.claudePath in config.json to its path ` +
                '(`which claude`; Windows: `where.exe claude`).'
            : `Claude CLI at ${cmd} could not be started: ${e.message}`,
          { fatal: true },
        ),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(hardKill);
      const stderr = err.trim().slice(0, 300);
      let res: { is_error?: boolean; result?: string; structured_output?: unknown } | null = null;
      try {
        res = JSON.parse(out);
      } catch {}
      if (res && !res.is_error && res.structured_output) return resolve(res.structured_output as T);
      if (res?.is_error || !res) {
        // The CLI's own error (or, with no JSON at all, its exit code and stderr), plus the usual fix.
        const said = [(typeof res?.result === 'string' && res.result.trim()) || `Claude CLI exited ${code}`, stderr]
          .filter(Boolean)
          .join(' ')
          .slice(0, 500)
          .replace(/[.\s]+$/, '');
        return reject(new AiError(`Claude CLI error: ${said}. ${CLAUDE_SIGN_IN_HINT}`, { fatal: CLAUDE_FATAL.test(said) }));
      }
      reject(new AiError(`Claude CLI gave no structured answer${stderr ? `: ${stderr}` : ''}`));
    });
    // A CLI that exits before reading the prompt (not installed right, signed out) closes the pipe: EPIPE here must
    // not crash the bot, the 'close' handler above reports what happened.
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

// ---- OpenAI-compatible chat APIs ----

type ApiRequest = { prompt: string; schema: object; kind: AiKind; system: string };
type ChatReply = { choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[] };

/** Why a reply is unusable; such a reply is asked for once more before failing. */
class BadReply extends Error {}

const redact = (s: string, key: string) => (key ? s.split(key).join('***') : s);

/** `s` with every AI key from the environment (AI_API_KEY and the older names) replaced by ***. For text that may
 * have come from a child process, such as a task's last error line. */
export function redactKeys(s: string, env: Env = process.env): string {
  for (const name of [AI_KEY_ENV, ...Object.values(LEGACY_KEY_ENV)]) {
    const key = env[name]?.trim();
    if (key) s = redact(s, key);
  }
  return s;
}

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

/**
 * A zod validator for the JSON-schema subset the prompts in src/ai.ts use (object, array, string with enum, integer
 * with minimum/maximum, number, boolean), so a reply with the right keys but the wrong shapes ("verdict": 42,
 * "location": "Berlin") is re-asked instead of written to the database. Only what the code reads is checked:
 * item counts and wording are left to the model. Unknown keys and unknown schema constructs are let through.
 */
export function validatorFor(schema: unknown): z.ZodType {
  const s = schema as {
    type?: string;
    enum?: string[];
    properties?: Record<string, unknown>;
    required?: string[];
    items?: unknown;
    minimum?: number;
    maximum?: number;
  };
  switch (s?.type) {
    case 'string':
      return s.enum?.length ? z.enum(s.enum as [string, ...string[]]) : z.string();
    case 'integer': {
      let n = z.number().int();
      if (s.minimum !== undefined) n = n.min(s.minimum);
      if (s.maximum !== undefined) n = n.max(s.maximum);
      return n;
    }
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'array':
      return z.array(s.items ? validatorFor(s.items) : z.unknown());
    case 'object': {
      const required = s.required ?? [];
      return z.object(
        Object.fromEntries(
          Object.entries(s.properties ?? {}).map(([k, p]) => [k, required.includes(k) ? validatorFor(p) : validatorFor(p).optional()]),
        ),
      );
    }
    default:
      return z.unknown();
  }
}

/** The JSON object in a reply, checked for the schema's required top-level keys and its field shapes. */
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
  const checked = validatorFor(schema).safeParse(obj);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    throw new BadReply(`reply does not match the schema at ${issue.path.join('.') || '$'}: ${issue.message}`);
  }
  // The original object, not zod's copy: keys the schema does not know are kept (and ignored by the code).
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

/** Thrown when the overall AI budget runs out while a request is still in flight. */
class BudgetExceeded extends Error {}

/** `p`, or a rejection with the signal's reason as soon as `signal` aborts, whichever comes first. postJson stops on
 * the same signal; this also settles when something does not honour it. */
function untilAborted<T>(signal: AbortSignal, p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

export async function askApi<T>(req: ApiRequest, ai: AiSettings = config.ai, env: Env = process.env): Promise<T> {
  const t = resolveApi(ai, env);
  const body = chatBody(t, req, req.kind === 'score' ? t.scoreModel : t.letterModel);
  const deadline = Date.now() + AI_BUDGET.ms;
  // The budget aborts the request itself (the fetch, a backoff wait, further retries), so nothing is left running
  // once the AiError is thrown and the CLI can exit right away. Cleared on every way out.
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(new BudgetExceeded(`no answer within the ${AI_BUDGET.ms / 1000}s AI budget`)), AI_BUDGET.ms);
  try {
    return await askApiWithin<T>(req, t, body, deadline, budget.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function askApiWithin<T>(
  req: ApiRequest,
  t: ApiTarget,
  body: Record<string, unknown>,
  deadline: number,
  signal: AbortSignal,
): Promise<T> {
  const headers: Record<string, string> = t.key ? { authorization: `Bearer ${t.key}` } : {};
  let last = '';
  // One more try when the reply is not the JSON asked for, told what was wrong so the model can correct itself;
  // HTTP retries (429, 5xx) happen inside postJson. Everything stops at the overall AI budget (AI_BUDGET).
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || signal.aborted) break;
    const ask = !attempt
      ? body
      : {
          ...body,
          messages: [
            ...(body.messages as object[]),
            {
              role: 'user',
              content: `Your previous reply was not valid: ${last}. Reply again with only one JSON object that matches the schema, no other text.`,
            },
          ],
        };
    let reply: ChatReply;
    try {
      reply = await untilAborted(
        signal,
        postJson<ChatReply>(t.url, ask, { headers, attempts: 3, timeoutMs: Math.min(AI_TIMEOUT_MS, remaining), signal }),
      );
    } catch (e) {
      if (e instanceof BudgetExceeded) {
        throw new AiError(redact(`${t.name} gave ${e.message}${last ? ` (last problem: ${last})` : ''}`, t.key), { timedOut: true });
      }
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
        // The provider's own words help ("api key is invalid", "no access to this model"), redacted like the rest.
        const said = apiMessage(e.body).trim();
        throw new AiError(redact(keyRejected(t, e.status, said ? `(${said})` : ''), t.key), { fatal: true });
      }
      if (e instanceof HttpError && e.status === 402) throw new AiError(noCredit(t), { fatal: true });
      const detail = e instanceof HttpError ? `${e.status} ${apiMessage(e.body)}` : (e as Error).message;
      // 404: a wrong base URL or model name, which fails the same way for every call until the setting is fixed.
      throw new AiError(redact(`${t.name} request failed: ${detail}`, t.key), { fatal: e instanceof HttpError && e.status === 404 });
    }
    try {
      return parseReply<T>(reply, req.schema);
    } catch (e) {
      if (!(e instanceof BadReply)) throw new AiError(redact(`${t.name}: ${(e as Error).message}`, t.key));
      last = e.message;
    }
  }
  const outOfTime = signal.aborted || Date.now() >= deadline;
  const why = outOfTime ? `no usable answer within the ${AI_BUDGET.ms / 1000}s AI budget` : 'no usable answer after 2 tries';
  throw new AiError(redact(`${t.name} gave ${why}: ${last}`, t.key), { timedOut: outOfTime });
}
