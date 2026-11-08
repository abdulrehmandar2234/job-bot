// The OpenAI-compatible chat APIs the bot knows by name, for `ai.provider: "api"` (src/ai-providers.ts).
// Pure data and functions with no imports, so the setup wizard can use them without loading config.json.
// The dashboard's Settings page imports them too (web/lib/settings-form.ts, client components included).

/**
 * How a provider is asked for JSON:
 * - json_schema: `response_format: { type: 'json_schema' }`, the provider enforces the schema;
 * - json_object: `response_format: { type: 'json_object' }` plus the schema in the system prompt;
 * - text: no response_format (the provider ignores or rejects it), the schema in the system prompt.
 */
export const RESPONSE_FORMATS = ['json_schema', 'json_object', 'text'] as const;
export type ResponseFormat = (typeof RESPONSE_FORMATS)[number];

export const API_PRESETS = [
  'openai',
  'deepseek',
  'anthropic',
  'gemini',
  'groq',
  'openrouter',
  'mistral',
  'together',
  'ollama',
  'custom',
] as const;
export type ApiPreset = (typeof API_PRESETS)[number];

export type Preset = {
  name: string;
  /** OpenAI-compatible base URL; requests go to `${baseUrl}/chat/completions`. Empty for custom. */
  baseUrl: string;
  scoreModel: string;
  letterModel: string;
  format: ResponseFormat;
  /** False when the API needs no key (a local Ollama). */
  needsKey: boolean;
  /** False when the API rejects `temperature` (Anthropic's current models). */
  temperature: boolean;
};

// Defaults only: every model can be changed in config.json ai.api or on the dashboard's Settings page.
export const PRESETS: Record<ApiPreset, Preset> = {
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    scoreModel: 'gpt-4o-mini',
    letterModel: 'gpt-4o',
    format: 'json_schema',
    needsKey: true,
    temperature: true,
  },
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    scoreModel: 'deepseek-chat',
    letterModel: 'deepseek-chat',
    format: 'json_object',
    needsKey: true,
    temperature: true,
  },
  // OpenAI SDK compatibility layer: response_format is ignored there, and current models reject temperature.
  anthropic: {
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    scoreModel: 'claude-haiku-5-5',
    letterModel: 'claude-sonnet-5-5',
    format: 'text',
    needsKey: true,
    temperature: false,
  },
  gemini: {
    name: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    scoreModel: 'gemini-2.5-flash',
    letterModel: 'gemini-2.5-pro',
    format: 'json_schema',
    needsKey: true,
    temperature: true,
  },
  groq: {
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    scoreModel: 'llama-3.1-8b-instant',
    letterModel: 'llama-3.3-70b-versatile',
    format: 'json_object',
    needsKey: true,
    temperature: true,
  },
  // Many models behind one key: JSON mode with the schema in the prompt works for most of them.
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    scoreModel: 'openai/gpt-4o-mini',
    letterModel: 'openai/gpt-4o',
    format: 'json_object',
    needsKey: true,
    temperature: true,
  },
  mistral: {
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    scoreModel: 'mistral-small-latest',
    letterModel: 'mistral-large-latest',
    format: 'json_schema',
    needsKey: true,
    temperature: true,
  },
  together: {
    name: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    scoreModel: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
    letterModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    format: 'json_object',
    needsKey: true,
    temperature: true,
  },
  ollama: {
    name: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    scoreModel: 'llama3.1',
    letterModel: 'llama3.1',
    format: 'json_object',
    needsKey: false,
    temperature: true,
  },
  // Any other OpenAI-compatible endpoint: base URL from AI_BASE_URL or ai.api.baseUrl, models from ai.api.
  custom: {
    name: 'Custom endpoint',
    baseUrl: '',
    scoreModel: '',
    letterModel: '',
    format: 'json_object',
    needsKey: false,
    temperature: true,
  },
};

/** The env variable for the one AI key, and the older per-provider names still read as fallbacks. */
export const AI_KEY_ENV = 'AI_API_KEY';
export const AI_BASE_URL_ENV = 'AI_BASE_URL';
export const LEGACY_KEY_ENV = { openai: 'OPENAI_API_KEY', deepseek: 'DEEPSEEK_API_KEY' } as const;

/**
 * The provider a key belongs to, from its prefix, or null when it cannot be told. DeepSeek keys also start with
 * "sk-", so they look like OpenAI keys: DeepSeek needs ai.api.preset "deepseek" (or AI_BASE_URL).
 */
export function detectPreset(key: string | undefined | null): ApiPreset | null {
  const k = key?.trim() ?? '';
  if (k.startsWith('sk-ant-')) return 'anthropic';
  if (k.startsWith('sk-or-')) return 'openrouter';
  if (k.startsWith('gsk_')) return 'groq';
  if (k.startsWith('AIza')) return 'gemini';
  if (k.startsWith('sk-')) return 'openai';
  return null;
}
