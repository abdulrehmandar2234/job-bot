'use client';

import { startTransition, useActionState, useState, type FormEvent, type ReactNode } from 'react';
import { saveApplicant, saveConfig, saveJson, type SaveState } from '@/app/settings/actions';
import type { SettingsFile } from '@/lib/settings';
import { APPLICANT_FACTS, ATS, errorsFor, get, SALARY_KEYS, type Json, type SettingsError, type SettingsKind } from '@/lib/settings-form';

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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-3 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
      <legend className="px-1 text-sm font-semibold">{title}</legend>
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

function SaveBar({ label, state, pending }: { label: string; state: SaveState; pending: boolean }) {
  return (
    <div className="flex flex-wrap items-start gap-3">
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

export function ConfigForm({ config }: { config: SettingsFile }) {
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
        <Section title="Matching">
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
        </Section>

        <Section title="Target countries">
          {countries.map(([code, country]) => (
            <Field
              key={code}
              label={`${text(country?.name) || code} (${code}, visa: ${text(country?.visa)})`}
              hint="location pattern"
              {...f(`countries.${code}.match`)}
            >
              <input name={`countries.${code}.match`} defaultValue={text(country?.match)} className={`${input} font-mono text-xs`} />
            </Field>
          ))}
        </Section>

        <Section title="LinkedIn">
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

        <Section title="Remote boards">
          <Check label="Search remote boards" name="remote.enabled" value={get(c, 'remote.enabled')} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Boards" hint="one per line: himalayas, remotive, remoteok, arbeitnow, adzuna" {...f('remote.boards')}>
              <textarea name="remote.boards" rows={3} defaultValue={lines(get(c, 'remote.boards'))} className={input} />
            </Field>
            <Field label="Himalayas queries" hint="one per line" {...f('remote.himalayasQueries')}>
              <textarea name="remote.himalayasQueries" rows={3} defaultValue={lines(get(c, 'remote.himalayasQueries'))} className={input} />
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

        <Section title="Adzuna">
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

        <Section title="AI review">
          <Check label="Use the AI (local Claude CLI)" name="ai.enabled" value={get(c, 'ai.enabled')} />
          {/* Missing means on (src/settings.ts), so only an explicit false unchecks it. */}
          <Check
            label="Alert me at once for strong matches (macOS notification)"
            name="ai.alertStrong"
            value={get(c, 'ai.alertStrong') !== false}
          />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Score model" {...f('ai.scoreModel')}>
              <input name="ai.scoreModel" defaultValue={text(get(c, 'ai.scoreModel'))} className={input} />
            </Field>
            <Field label="Letter model" {...f('ai.letterModel')}>
              <input name="ai.letterModel" defaultValue={text(get(c, 'ai.letterModel'))} className={input} />
            </Field>
            <Field label="Max AI scores per run" {...f('ai.maxScorePerRun')}>
              <input type="number" min={0} name="ai.maxScorePerRun" defaultValue={text(get(c, 'ai.maxScorePerRun'))} className={input} />
            </Field>
          </div>
        </Section>

        <Section title="Companies (careers pages)">
          <CompaniesEditor companies={c.companies} errors={errors} />
        </Section>
      </div>
      <SaveBar label="Save search settings" state={state} pending={pending} />
    </form>
  );
}

// ---- cv/applicant.json ----

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

export function ApplicantForm({ applicant }: { applicant: SettingsFile }) {
  const { state, pending, onSubmit, errors } = useSave(saveApplicant);
  const a = applicant.data;
  if (!a)
    return (
      <p role="alert" className="text-sm text-rose-700">
        applicant.json cannot be read ({applicant.error}). Fix it under &quot;Advanced: edit JSON&quot;.
      </p>
    );
  return (
    <form onSubmit={onSubmit} aria-label="Applicant facts" className="space-y-4">
      {applicant.example && (
        <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          cv/applicant.json does not exist yet, so these are the example values. Saving creates it.
        </p>
      )}
      <p className="text-sm text-zinc-500">Leave a field empty when unknown: the AI then writes [FILL: …] instead of guessing.</p>
      <div key={applicant.text} className="space-y-4">
        <Section title="Facts">
          <div className="grid gap-3 sm:grid-cols-2">
            {APPLICANT_FACTS.map((k) => (
              <Field key={k} label={FACT_LABEL[k]} name={k} errors={errors}>
                <input name={k} defaultValue={text(a[k])} className={input} />
              </Field>
            ))}
          </div>
        </Section>
        <Section title="Expected salary">
          <div className="grid gap-3 sm:grid-cols-4">
            {SALARY_KEYS.map((k) => (
              <Field key={k} label={k === 'remote' ? 'Remote' : k} name={`expectedSalary.${k}`} errors={errors}>
                <input name={`expectedSalary.${k}`} defaultValue={text(get(a, `expectedSalary.${k}`))} className={input} />
              </Field>
            ))}
          </div>
        </Section>
        <Section title="Other facts">
          <OtherEditor other={a.other} errors={errors} />
        </Section>
      </div>
      <SaveBar label="Save applicant facts" state={state} pending={pending} />
    </form>
  );
}

// ---- Raw JSON ----

export function JsonEditor({ kind, file }: { kind: SettingsKind; file: SettingsFile }) {
  const { state, pending, onSubmit } = useSave(saveJson);
  return (
    <details className="rounded-xl border border-zinc-200 px-4 py-3 text-sm dark:border-zinc-800">
      <summary className="cursor-pointer font-medium">Advanced: edit JSON</summary>
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
