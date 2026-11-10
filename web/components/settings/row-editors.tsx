'use client';

import { useState } from 'react';
import { ATS, errorsFor, type Json, type SettingsError } from '@/lib/settings-form';
import { FieldErrors, input, text } from './fields';

// The editable lists of the Settings forms: config.json's companies and applicant.json's other facts. Adding or
// removing a row calls `onEdit` (the form's unsaved-changes mark), since it changes no input itself.

type CompanyRow = { key: number; orig: number; name: string; ats: string; token: string };

export function CompaniesEditor({ companies, errors, onEdit }: { companies: unknown; errors: SettingsError[]; onEdit?: () => void }) {
  const list = Array.isArray(companies) ? (companies as Json[]) : [];
  const [rows, setRows] = useState<CompanyRow[]>(() =>
    list.map((c, i) => ({ key: i, orig: i, name: text(c?.name), ats: text(c?.ats), token: text(c?.token) })),
  );
  const [next, setNext] = useState(list.length);
  const add = () => {
    setRows([...rows, { key: next, orig: -1, name: '', ats: ATS[0], token: '' }]);
    setNext(next + 1);
    onEdit?.();
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
              onClick={() => {
                setRows(rows.filter((x) => x.key !== r.key));
                onEdit?.();
              }}
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

type OtherRow = { key: number; name: string; value: string };

export function OtherEditor({ other, errors, onEdit }: { other: unknown; errors: SettingsError[]; onEdit?: () => void }) {
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
            onClick={() => {
              setRows(rows.filter((x) => x.key !== r.key));
              onEdit?.();
            }}
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
          onEdit?.();
        }}
      >
        + Add fact
      </button>
    </div>
  );
}
