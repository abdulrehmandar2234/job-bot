'use client';

import { saveJson } from '@/app/settings/actions';
import type { SettingsFile } from '@/lib/settings';
import type { SettingsKind } from '@/lib/settings-form';
import { sectionTitle } from '@/lib/settings-sections';
import { input, SaveBar, useSave } from './fields';

/** "Advanced: edit JSON": the whole file as text, saved after the same checks as the forms. */
export function JsonEditor({ kind, file }: { kind: SettingsKind; file: SettingsFile }) {
  const { state, pending, onSubmit, onEdit } = useSave(saveJson);
  return (
    <details id={`${kind}-json`} className="scroll-mt-4 rounded-xl border border-zinc-200 px-4 py-3 text-sm dark:border-zinc-800">
      <summary className="cursor-pointer font-medium">{sectionTitle(`${kind}-json`)}</summary>
      <form onSubmit={onSubmit} onChange={onEdit} aria-label={`Edit ${kind} JSON`} className="mt-3 space-y-3">
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
