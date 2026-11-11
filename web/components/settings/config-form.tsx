'use client';

import { saveConfig } from '@/app/settings/actions';
import type { AiKeyStatus, SettingsFile } from '@/lib/settings';
import { DEFAULT_TEMPLATE, TEMPLATES } from '@/lib/cv-template-list';
import { DEFAULT_DAILY_TIME, get, type Json } from '@/lib/settings-form';
import { AiSection } from './ai-section';
import { Check, Field, input, lines, SaveBar, Section, text, useSave } from './fields';
import { CompaniesEditor } from './row-editors';

/** The Settings page's form for config.json: matching, countries, sources, the AI and the companies. */
export function ConfigForm({ config, keys, bot = 'npm run bot --' }: { config: SettingsFile; keys?: AiKeyStatus; bot?: string }) {
  const { state, pending, onSubmit, onEdit, errors } = useSave(saveConfig);
  const c = config.data;
  if (!c)
    return (
      <p role="alert" className="text-sm text-rose-700 dark:text-rose-400">
        config.json cannot be read ({config.error}). Fix it under &quot;Advanced: edit JSON&quot;.
      </p>
    );
  const countries = Object.entries((c.countries ?? {}) as Record<string, Json>);
  const f = (name: string) => ({ name, errors });
  return (
    <form onSubmit={onSubmit} onChange={onEdit} aria-label="Search settings" className="space-y-4">
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
            <Field label="Daily run time" hint="local time; the daily fetch starts then (default 09:00)" {...f('dailyTime')}>
              <input type="time" name="dailyTime" defaultValue={text(c.dailyTime) || DEFAULT_DAILY_TIME} className={input} />
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
          <p className="text-xs text-zinc-500">Add or remove countries with `{bot} setup` or under &quot;Advanced: edit JSON&quot;.</p>
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
            <Field
              label="Boards"
              hint="one per line: himalayas, remotive, remoteok, arbeitnow, adzuna, jobicy, hackernews, freehire"
              {...f('remote.boards')}
            >
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
          <p className="text-xs text-zinc-500">
            Which remote jobs are open to you is worked out from the country code above (its regions, such as South Asia or EMEA, and its
            time zone). Leave the region patterns empty for that; fill one in only to replace it.
          </p>
          {(['allow', 'deny', 'flag'] as const).map((k) => (
            <Field key={k} label={`Region ${k}`} hint="regular expression; empty = automatic" {...f(`remote.${k}`)}>
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
          <CompaniesEditor companies={c.companies} errors={errors} onEdit={onEdit} />
        </Section>
      </div>
      <SaveBar label="Save search settings" state={state} pending={pending} sticky />
    </form>
  );
}
