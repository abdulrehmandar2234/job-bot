'use client';

import { useState } from 'react';
import type { AiKeyStatus } from '@/lib/settings';
import { AI_KEY_ENV, API_PRESETS, get, isApiProvider, PRESETS, type ApiPreset, type Json, type SettingsError } from '@/lib/settings-form';
import { Check, Field, input, Section, text } from './fields';

const article = (name: string) => (/^[AEIOU]/.test(name) ? 'an' : 'a');

/** The key status line: the variable name and whose key it looks like, never the key. */
function keyStatus(keys: AiKeyStatus | undefined, preset: string): { ok: boolean; text: string } {
  if (preset === 'ollama') return { ok: true, text: 'Ollama needs no key; it must be running on this Mac.' };
  if (!keys?.keyEnv) return { ok: false, text: `${AI_KEY_ENV} is not set: the AI features will fail until you add it to .env.` };
  if (!keys.provider) {
    const hint = preset ? '' : ': choose its provider below';
    return { ok: !!preset, text: `${keys.keyEnv} is set (its provider cannot be told from the key${hint}).` };
  }
  const name = PRESETS[keys.provider].name;
  return { ok: true, text: `${keys.keyEnv} is set (looks like ${article(name)} ${name} key).` };
}

/** "AI review": Claude CLI or one API key, the preset and models, and whether the key is set (never the key). */
export function AiSection({ c, errors, keys }: { c: Json; errors: SettingsError[]; keys?: AiKeyStatus }) {
  const saved = get(c, 'ai.provider');
  // "openai" / "deepseek" are older names for "api" with that preset; their section's models are shown in ai.api.
  const legacy = saved === 'openai' || saved === 'deepseek' ? saved : null;
  const [provider, setProvider] = useState(isApiProvider(saved) ? 'api' : 'claude-cli');
  const [preset, setPreset] = useState(text(get(c, 'ai.api.preset')) || legacy || '');
  const f = (name: string) => ({ name, errors });
  const apiValue = (k: string) => text(get(c, `ai.api.${k}`)) || (legacy ? text(get(c, `ai.${legacy}.${k}`)) : '');
  // The preset the bot will use: the chosen one, else the one the key looks like.
  const effective = (preset || keys?.provider || '') as ApiPreset | '';
  const defaults = effective ? PRESETS[effective] : null;
  const status = keyStatus(keys, preset);
  return (
    <Section id="ai-review">
      <Check label="Use the AI" name="ai.enabled" value={get(c, 'ai.enabled')} />
      {/* Missing means on (src/settings.ts), so only an explicit false unchecks it. */}
      <Check
        label="Alert me at once for strong matches (macOS notification)"
        name="ai.alertStrong"
        value={get(c, 'ai.alertStrong') !== false}
      />
      <Field
        label="AI provider"
        hint={
          provider === 'api'
            ? 'any OpenAI-compatible API with one key: paid per token'
            : 'your signed-in Claude Code CLI: no API key, usage comes from your Claude plan'
        }
        {...f('ai.provider')}
      >
        <select name="ai.provider" value={provider} onChange={(e) => setProvider(e.target.value)} className={input}>
          <option value="claude-cli">Claude CLI</option>
          <option value="api">API key</option>
        </select>
      </Field>
      {provider === 'api' && (
        <>
          <p
            data-testid="ai-key-status"
            className={`text-sm ${status.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}`}
          >
            {status.text}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="API provider" hint="auto = told from the key's prefix" {...f('ai.api.preset')}>
              <select name="ai.api.preset" value={preset} onChange={(e) => setPreset(e.target.value)} className={input}>
                <option value="">Auto-detect from key</option>
                {API_PRESETS.map((p) => (
                  <option key={p} value={p}>
                    {p === 'custom' ? 'Custom' : PRESETS[p].name}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Base URL"
              hint={defaults?.baseUrl ? `empty = ${defaults.baseUrl}` : 'OpenAI-compatible, e.g. https://host/v1'}
              {...f('ai.api.baseUrl')}
            >
              <input name="ai.api.baseUrl" defaultValue={apiValue('baseUrl')} className={input} />
            </Field>
            <Field
              label="API score model"
              hint={defaults?.scoreModel ? `empty = ${defaults.scoreModel}` : undefined}
              {...f('ai.api.scoreModel')}
            >
              <input name="ai.api.scoreModel" defaultValue={apiValue('scoreModel')} className={input} />
            </Field>
            <Field
              label="API letter model"
              hint={defaults?.letterModel ? `empty = ${defaults.letterModel}` : undefined}
              {...f('ai.api.letterModel')}
            >
              <input name="ai.api.letterModel" defaultValue={apiValue('letterModel')} className={input} />
            </Field>
          </div>
          <p className="text-xs text-zinc-500">
            DeepSeek keys also start with sk- and look like OpenAI keys: for DeepSeek, choose it above.
          </p>
        </>
      )}
      <p className="text-xs text-zinc-500">
        API keys are never entered here or stored in config.json: put {AI_KEY_ENV}=... in .env in the job-bot folder (see .env.example).
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Claude CLI score model" {...f('ai.scoreModel')}>
          <input name="ai.scoreModel" defaultValue={text(get(c, 'ai.scoreModel'))} className={input} />
        </Field>
        <Field label="Claude CLI letter model" {...f('ai.letterModel')}>
          <input name="ai.letterModel" defaultValue={text(get(c, 'ai.letterModel'))} className={input} />
        </Field>
        <Field label="Max AI scores per run" {...f('ai.maxScorePerRun')}>
          <input type="number" min={0} name="ai.maxScorePerRun" defaultValue={text(get(c, 'ai.maxScorePerRun'))} className={input} />
        </Field>
      </div>
    </Section>
  );
}
