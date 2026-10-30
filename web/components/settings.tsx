'use client';

import { startTransition, useActionState, useState, type FormEvent, type ReactNode } from 'react';
import { saveApplicant, saveConfig, saveJson, type SaveState } from '@/app/settings/actions';
import type { AiKeyStatus, SettingsFile } from '@/lib/settings';
import { DEFAULT_TEMPLATE, TEMPLATES } from '@/lib/cv-template-list';
import {
  AI_KEY_ENV,
  API_PRESETS,
  APPLICANT_FACTS,
  ATS,
  errorsFor,
  get,
  isApiProvider,
  LETTER_FIELDS,
  PRESETS,
  PROFILE_FIELDS,
  type ApiPreset,
  type Json,
  type SettingsError,
  type SettingsKind,
} from '@/lib/settings-form';
import { type SettingsSectionId, sectionTitle } from '@/lib/settings-sections';

type Action = (prev: SaveState, fd: FormData) => Promise<SaveState>;

/**
 * Submits through useActionState from onSubmit rather than <form action>, because React resets a form after an
 * action prop runs, which would wipe the user's edits when the save is rejected with errors.
 */
function useSave(action: Action) {
  const [state, dispatch, pending] = useActionState(action, null);
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(() => dispatch(fd));
  };
  return { state, pending, onSubmit, errors: state?.errors ?? [] };
}

/** "Saved" / the error summary, next to the save button. */
export function SaveStatus({ state, pending }: { state: SaveState; pending: boolean }) {
  if (pending) return <span className="text-sm text-zinc-500">Saving…</span>;
  if (!state) return null;
  if (state.ok)
    return (
      <span role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
        {state.message}
      </span>
    );
  return (
    <div role="alert" className="text-sm text-rose-700 dark:text-rose-400">
      <p className="font-medium">{state.message}</p>
      {state.errors.length > 0 && (
        <ul className="list-disc pl-5">
          {state.errors.map((e, i) => (
            <li key={i}>
              <code>{e.path}</code>: {e.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FieldErrors({ errors }: { errors: SettingsError[] }) {
  if (!errors.length) return null;
  return <p className="mt-1 text-xs text-rose-700 dark:text-rose-400">{errors.map((e) => e.message).join('; ')}</p>;
}

function Field({
  label,
  name,
  errors,
  hint,
  children,
}: {
  label: string;
  name: string;
  errors: SettingsError[];
  hint?: string;
  children: ReactNode;
}) {
  const own = errorsFor(errors, name);
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed in as children
    <label className="block text-sm" data-invalid={own.length > 0 || undefined}>
      <span className="font-medium">{label}</span>
      {hint && <span className="ml-1 text-xs text-zinc-500">{hint}</span>}
      <div className="mt-1">{children}</div>
      <FieldErrors errors={own} />
    </label>
  );
}

const input = 'input w-full';
const text = (v: unknown) => (v == null ? '' : String(v));
const lines = (v: unknown) => (Array.isArray(v) ? v.join('\n') : '');

/** One card of the Settings page; its id (the section nav's anchor) and title come from lib/settings-sections.ts. */
function Section({ id, children }: { id: SettingsSectionId; children: ReactNode }) {
  return (
    <fieldset id={id} className="scroll-mt-4 space-y-3 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
      <legend className="px-1 text-sm font-semibold">{sectionTitle(id)}</legend>
      {children}
    </fieldset>
  );
}

function Check({ label, name, value }: { label: string; name: string; value: unknown }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" name={name} defaultChecked={value === true} /> {label}
    </label>
  );
}

/**
 * The save button and its status. `sticky` keeps it at the bottom of the window while its (long) form is on screen, so
 * the button and the result of a save are always in view; it scrolls away with the form.
 */
function SaveBar({ label, state, pending, sticky }: { label: string; state: SaveState; pending: boolean; sticky?: boolean }) {
  const stick = sticky
    ? 'sticky bottom-0 z-10 max-h-[40vh] overflow-y-auto rounded-xl border border-zinc-200 bg-background/95 p-3 backdrop-blur dark:border-zinc-800'
    : '';
  return (
    <div data-testid="save-bar" className={`flex flex-wrap items-start gap-3 ${stick}`}>
      <button type="submit" disabled={pending} className={`btn btn-primary ${pending ? 'cursor-wait opacity-60' : ''}`}>
        {label}
      </button>
      <SaveStatus state={state} pending={pending} />
    </div>
  );
}

// ---- config.json ----

type CompanyRow = { key: number; orig: number; name: string; ats: string; token: string };

function CompaniesEditor({ companies, errors }: { companies: unknown; errors: SettingsError[] }) {
  const list = Array.isArray(companies) ? (companies as Json[]) : [];
  const [rows, setRows] = useState<CompanyRow[]>(() =>
    list.map((c, i) => ({ key: i, orig: i, name: text(c?.name), ats: text(c?.ats), token: text(c?.token) })),
  );
  const [next, setNext] = useState(list.length);
  const add = () => {
    setRows([...rows, { key: next, orig: -1, name: '', ats: ATS[0], token: '' }]);
    setNext(next + 1);
  };
  return (
    <div className="space-y-2">
      <FieldErrors errors={errorsFor(errors, 'companies')} />
      {rows.map((r, i) => {
        const p = `companies[${i}]`;
        // Keep an ats value the dashboard does not know yet instead of silently changing it.
        const options = ATS.includes(r.ats as (typeof ATS)[number]) || !r.ats ? ATS : [r.ats, ...ATS];
        return (
          <div key={r.key} data-testid="company-row" className="grid grid-cols-[1fr_9rem_1fr_auto] items-start gap-2">
            <input type="hidden" name={`${p}.orig`} value={r.orig} />
            <div>
              <input aria-label={`Company ${i + 1} name`} name={`${p}.name`} defaultValue={r.name} className={input} />
              <FieldErrors errors={errorsFor(errors, `${p}.name`)} />
            </div>
            <div>
              <select aria-label={`Company ${i + 1} ATS`} name={`${p}.ats`} defaultValue={r.ats} className={input}>
                {options.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
              <FieldErrors errors={errorsFor(errors, `${p}.ats`)} />
            </div>
            <div>
              <input aria-label={`Company ${i + 1} token`} name={`${p}.token`} defaultValue={r.token} className={input} />
              <FieldErrors errors={errorsFor(errors, `${p}.token`)} />
            </div>
            <button
              type="button"
              className="btn"
              aria-label={`Remove company ${i + 1}`}
              onClick={() => setRows(rows.filter((x) => x.key !== r.key))}
            >
              ✕
            </button>
          </div>
        );
      })}
      <button type="button" className="btn" onClick={add}>
        + Add company
      </button>
    </div>
  );
}

export function ConfigForm({ config, keys }: { config: SettingsFile; keys?: AiKeyStatus }) {
  const { state, pending, onSubmit, errors } = useSave(saveConfig);
  const c = config.data;
  if (!c)
    return (
      <p role="alert" className="text-sm text-rose-700">
        config.json cannot be read ({config.error}). Fix it under &quot;Advanced: edit JSON&quot;.
      </p>
    );
  const countries = Object.entries((c.countries ?? {}) as Record<string, Json>);
  const f = (name: string) => ({ name, errors });
  return (
    <form onSubmit={onSubmit} aria-label="Search settings" className="space-y-4">
      {/* Remounts the fields when the file changes on disk (e.g. after a JSON save), so they show what was saved. */}
      <div key={config.text} className="space-y-4">
        <Section id="matching">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Minimum score" {...f('minScore')}>
              <input type="number" name="minScore" defaultValue={text(c.minScore)} className={input} />
            </Field>
            <Field label="Max posting age (days)" {...f('maxAgeDays')}>
              <input type="number" min={0} name="maxAgeDays" defaultValue={text(c.maxAgeDays)} className={input} />
            </Field>
          </div>
          <Field label="Role include" hint="regular expression" {...f('roleInclude')}>
            <textarea name="roleInclude" rows={2} defaultValue={text(c.roleInclude)} className={`${input} font-mono text-xs`} />
          </Field>
          <Field label="Role exclude" hint="regular expression" {...f('roleExclude')}>
            <textarea name="roleExclude" rows={2} defaultValue={text(c.roleExclude)} className={`${input} font-mono text-xs`} />
          </Field>
          <Check label="Pick a CV version automatically (autoCvVersions)" name="autoCvVersions" value={c.autoCvVersions} />
          <Field label="CV template" hint="the design of new CVs; a job can use another one" {...f('cvTemplate')}>
            {/* Classic is the built-in default, so choosing it leaves the key out of config.json. */}
            <select name="cvTemplate" defaultValue={text(c.cvTemplate) === 'classic' ? '' : text(c.cvTemplate)} className={input}>
              {TEMPLATES.map((t) => (
                <option key={t.id} value={t.id === DEFAULT_TEMPLATE ? '' : t.id}>
                  {t.name} · {t.description}
                </option>
              ))}
            </select>
          </Field>
          <p className="text-xs text-zinc-500">
            Preview:{' '}
            {TEMPLATES.map((t, i) => (
              <span key={t.id}>
                {i > 0 && ' · '}
                <a href={`/api/cv/preview/${t.id}`} target="_blank" rel="noreferrer" className="underline">
                  {t.name}
                </a>
              </span>
            ))}
          </p>
        </Section>

        <Section id="countries">
          {countries.map(([code, country]) => (
            <div key={code} className="space-y-2 border-b border-zinc-100 pb-3 last:border-0 dark:border-zinc-900">
              <Field
                label={`${text(country?.name) || code} (${code}, visa: ${text(country?.visa)})`}
                hint="location pattern"
                {...f(`countries.${code}.match`)}
              >
                <input name={`countries.${code}.match`} defaultValue={text(country?.match)} className={`${input} font-mono text-xs`} />
              </Field>
              <div className="grid items-end gap-3 sm:grid-cols-2">
                <Field label={`${code} label`} hint="short name on the dashboard, optional" {...f(`countries.${code}.label`)}>
                  <input name={`countries.${code}.label`} defaultValue={text(country?.label)} className={input} />
                </Field>
                {/* Missing means a visa is needed (src/settings.ts), so only an explicit false unchecks it. */}
                <Check
                  label={`I need a work visa for ${text(country?.name) || code}`}
                  name={`countries.${code}.needsVisa`}
                  value={country?.needsVisa !== false}
                />
              </div>
            </div>
          ))}
          <p className="text-xs text-zinc-500">
            Add or remove countries with `npm run bot -- setup` or under &quot;Advanced: edit JSON&quot;.
          </p>
        </Section>

        <Section id="linkedin">
          <Check label="Search LinkedIn" name="linkedin.enabled" value={get(c, 'linkedin.enabled')} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Keywords" hint="one per line" {...f('linkedin.keywords')}>
              <textarea name="linkedin.keywords" rows={5} defaultValue={lines(get(c, 'linkedin.keywords'))} className={input} />
            </Field>
            <Field label="Locations" hint="one per line" {...f('linkedin.locations')}>
              <textarea name="linkedin.locations" rows={5} defaultValue={lines(get(c, 'linkedin.locations'))} className={input} />
            </Field>
            <Field label="Remote search from" {...f('linkedin.remoteFrom')}>
              <input name="linkedin.remoteFrom" defaultValue={text(get(c, 'linkedin.remoteFrom'))} className={input} />
            </Field>
            <Field label="Pages per search" hint="10 results each" {...f('linkedin.pagesPerSearch')}>
              <input
                type="number"
                min={0}
                name="linkedin.pagesPerSearch"
                defaultValue={text(get(c, 'linkedin.pagesPerSearch'))}
                className={input}
              />
            </Field>
          </div>
        </Section>

        <Section id="remote-boards">
          <Check label="Search remote boards" name="remote.enabled" value={get(c, 'remote.enabled')} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Boards" hint="one per line: himalayas, remotive, remoteok, arbeitnow, adzuna" {...f('remote.boards')}>
              <textarea name="remote.boards" rows={3} defaultValue={lines(get(c, 'remote.boards'))} className={input} />
            </Field>
            <Field label="Himalayas queries" hint="one per line" {...f('remote.himalayasQueries')}>
              <textarea name="remote.himalayasQueries" rows={3} defaultValue={lines(get(c, 'remote.himalayasQueries'))} className={input} />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Remote work from (country)" hint="empty = LinkedIn remote search, then your profile" {...f('remote.from')}>
              <input name="remote.from" defaultValue={text(get(c, 'remote.from'))} className={input} />
            </Field>
            <Field label="Its country code" hint="two letters, e.g. PT; empty = your profile's" {...f('remote.fromCode')}>
              <input name="remote.fromCode" maxLength={2} defaultValue={text(get(c, 'remote.fromCode'))} className={input} />
            </Field>
          </div>
          <p className="text-xs text-zinc-500">
            Adzuna needs a free API key: set ADZUNA_APP_ID and ADZUNA_APP_KEY in .env, or it is skipped.
          </p>
          {(['allow', 'deny', 'flag'] as const).map((k) => (
            <Field key={k} label={`Region ${k}`} hint="regular expression" {...f(`remote.${k}`)}>
              <textarea name={`remote.${k}`} rows={2} defaultValue={text(get(c, `remote.${k}`))} className={`${input} font-mono text-xs`} />
            </Field>
          ))}
        </Section>

        <Section id="adzuna">
          <p className="text-xs text-zinc-500">
            Used when &quot;adzuna&quot; is in the remote boards list. Leave everything empty for the defaults (nl, 2 pages).
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Adzuna countries" hint="one per line, e.g. nl" {...f('adzuna.countries')}>
              <textarea name="adzuna.countries" rows={3} defaultValue={lines(get(c, 'adzuna.countries'))} className={input} />
            </Field>
            <Field label="Adzuna keywords" hint="optional, one per line; empty = LinkedIn keywords" {...f('adzuna.keywords')}>
              <textarea name="adzuna.keywords" rows={3} defaultValue={lines(get(c, 'adzuna.keywords'))} className={input} />
            </Field>
            <Field label="Adzuna pages per search" hint="50 results each" {...f('adzuna.pagesPerSearch')}>
              <input
                type="number"
                min={0}
                name="adzuna.pagesPerSearch"
                defaultValue={text(get(c, 'adzuna.pagesPerSearch'))}
                className={input}
              />
            </Field>
          </div>
        </Section>

        <AiSection c={c} errors={errors} keys={keys} />

        <Section id="companies">
          <CompaniesEditor companies={c.companies} errors={errors} />
        </Section>
      </div>
      <SaveBar label="Save search settings" state={state} pending={pending} sticky />
    </form>
  );
}

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
function AiSection({ c, errors, keys }: { c: Json; errors: SettingsError[]; keys?: AiKeyStatus }) {
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

// ---- cv/applicant.json ----

const PROFILE_LABEL: Record<(typeof PROFILE_FIELDS)[number], [string, string?]> = {
  fullName: ['Full name', 'empty = name on your CV'],
  email: ['Email', 'empty = email on your CV'],
  phone: ['Phone', 'empty = phone on your CV'],
  linkedin: ['LinkedIn URL', 'empty = LinkedIn on your CV'],
  city: ['City you live in'],
  country: ['Country you live in'],
  countryCode: ['Country code', 'two letters, e.g. PT'],
  utcOffset: ['UTC offset', 'e.g. GMT+1'],
  workAuthorization: ['Work authorisation', 'citizenship, permits'],
};

const LETTER_LABEL: Record<(typeof LETTER_FIELDS)[number], [string, string]> = {
  intro: ['Introduction', 'e.g. "I am a Full Stack Engineer with 5 years of experience ..."'],
  'pitch.default': ['Pitch', 'one sentence on your strongest recent work'],
  strengths: ['How you work', 'after "Your posting asks for X, which is the core of my day-to-day work."'],
  remote: ['Remote experience', 'after "I am based in <city> (<UTC offset>)," e.g. "have worked remotely with ..."'],
};

const FACT_LABEL: Record<(typeof APPLICANT_FACTS)[number], string> = {
  currentLocation: 'Current location',
  languages: 'Languages',
  needsVisaSponsorship: 'Needs visa sponsorship',
  willingToRelocate: 'Willing to relocate',
  nationality: 'Nationality',
  noticePeriod: 'Notice period',
  earliestStartDate: 'Earliest start date',
  currentSalary: 'Current salary',
  workingHoursForRemote: 'Working hours for remote roles',
  howDidYouHear: 'How did you hear about us',
};

type OtherRow = { key: number; name: string; value: string };

function OtherEditor({ other, errors }: { other: unknown; errors: SettingsError[] }) {
  const entries = other && typeof other === 'object' ? Object.entries(other as Json) : [];
  const [rows, setRows] = useState<OtherRow[]>(() => entries.map(([k, v], i) => ({ key: i, name: k, value: text(v) })));
  const [next, setNext] = useState(entries.length);
  return (
    <div className="space-y-2">
      <FieldErrors errors={errorsFor(errors, 'other')} />
      {rows.map((r, i) => (
        <div key={r.key} data-testid="other-row" className="grid grid-cols-[1fr_2fr_auto] items-start gap-2">
          <input aria-label={`Other fact ${i + 1} name`} name={`other[${i}].key`} defaultValue={r.name} className={input} />
          <div>
            <input aria-label={`Other fact ${i + 1} value`} name={`other[${i}].value`} defaultValue={r.value} className={input} />
            <FieldErrors errors={errorsFor(errors, `other.${r.name}`)} />
          </div>
          <button
            type="button"
            className="btn"
            aria-label={`Remove other fact ${i + 1}`}
            onClick={() => setRows(rows.filter((x) => x.key !== r.key))}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn"
        onClick={() => {
          setRows([...rows, { key: next, name: '', value: '' }]);
          setNext(next + 1);
        }}
      >
        + Add fact
      </button>
    </div>
  );
}

export function ApplicantForm({ applicant, salaryKeys = ['remote'] }: { applicant: SettingsFile; salaryKeys?: string[] }) {
  const { state, pending, onSubmit, errors } = useSave(saveApplicant);
  const a = applicant.data;
  if (!a)
    return (
      <p role="alert" className="text-sm text-rose-700">
        applicant.json cannot be read ({applicant.error}). Fix it under &quot;Advanced: edit JSON&quot;.
      </p>
    );
  // Without cv/applicant.json the example person's values are only shown as placeholders, never saved as yours.
  const value = (path: string) =>
    applicant.example ? { defaultValue: '', placeholder: text(get(a, path)) } : { defaultValue: text(get(a, path)) };
  return (
    <form onSubmit={onSubmit} aria-label="Applicant facts" className="space-y-4">
      {applicant.example && (
        <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          cv/applicant.json does not exist yet: the grey text shows an example person. Saving creates your file.
        </p>
      )}
      <p className="text-sm text-zinc-500">Leave a field empty when unknown: the AI then writes [FILL: …] instead of guessing.</p>
      <div key={applicant.text} className="space-y-4">
        <Section id="profile">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {PROFILE_FIELDS.map((k) => (
              <Field key={k} label={PROFILE_LABEL[k][0]} hint={PROFILE_LABEL[k][1]} name={k} errors={errors}>
                <input name={k} {...value(k)} className={input} />
              </Field>
            ))}
          </div>
        </Section>
        <Section id="facts">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {APPLICANT_FACTS.map((k) => (
              <Field key={k} label={FACT_LABEL[k]} name={k} errors={errors}>
                <input name={k} {...value(k)} className={input} />
              </Field>
            ))}
          </div>
        </Section>
        <Section id="cover-letter">
          <p className="text-xs text-zinc-500">Used when the AI is off or fails. Empty sentences are left out.</p>
          {LETTER_FIELDS.map((k) => (
            <Field key={k} label={LETTER_LABEL[k][0]} hint={LETTER_LABEL[k][1]} name={`coverLetter.${k}`} errors={errors}>
              <textarea name={`coverLetter.${k}`} rows={2} {...value(`coverLetter.${k}`)} className={input} />
            </Field>
          ))}
        </Section>
        <Section id="expected-salary">
          <div className="grid gap-3 sm:grid-cols-4">
            {salaryKeys.map((k) => (
              <Field key={k} label={k === 'remote' ? 'Remote' : k} name={`expectedSalary.${k}`} errors={errors}>
                <input name={`expectedSalary.${k}`} {...value(`expectedSalary.${k}`)} className={input} />
              </Field>
            ))}
          </div>
        </Section>
        <Section id="other-facts">
          <OtherEditor other={a.other} errors={errors} />
        </Section>
      </div>
      <SaveBar label="Save applicant facts" state={state} pending={pending} sticky />
    </form>
  );
}

// ---- Raw JSON ----

export function JsonEditor({ kind, file }: { kind: SettingsKind; file: SettingsFile }) {
  const { state, pending, onSubmit } = useSave(saveJson);
  return (
    <details id={`${kind}-json`} className="scroll-mt-4 rounded-xl border border-zinc-200 px-4 py-3 text-sm dark:border-zinc-800">
      <summary className="cursor-pointer font-medium">{sectionTitle(`${kind}-json`)}</summary>
      <form onSubmit={onSubmit} aria-label={`Edit ${kind} JSON`} className="mt-3 space-y-3">
        <p className="text-xs text-zinc-500">{file.file}</p>
        <input type="hidden" name="kind" value={kind} />
        <textarea
          key={file.text}
          name="json"
          aria-label={`${kind} JSON`}
          rows={20}
          defaultValue={file.text}
          spellCheck={false}
          className={`${input} font-mono text-xs`}
        />
        <SaveBar label="Save JSON" state={state} pending={pending} />
      </form>
    </details>
  );
}
