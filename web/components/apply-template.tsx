'use client';

import { applyCvTemplate } from '@/app/actions';
import { TEMPLATES, type TemplateId } from '@/lib/cv-template-list';
import type { TaskKind } from '@/lib/tasks';
import { Problem, useTextForm } from './form-state';

/**
 * The template select with "Apply template" (`bot cv:template`, used by CvPanel). A client form (useTextForm), so a
 * refusal — another task started changing this CV after the page rendered — is shown instead of dropping the click.
 */
export function ApplyTemplateForm({
  id,
  chosen,
  fallback,
  changing,
}: {
  id: string;
  chosen: TemplateId;
  fallback: TemplateId;
  changing: TaskKind | null;
}) {
  const { state, pending, onSubmit } = useTextForm(applyCvTemplate);
  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="id" value={id} />
      <label className="text-sm">
        <span className="block text-zinc-500">Template</span>
        <select name="template" defaultValue={chosen} className="input">
          {TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.id === fallback ? ' (default)' : ''}
            </option>
          ))}
        </select>
      </label>
      {changing === 'cv_template' ? (
        <span role="status" className="btn cursor-wait opacity-60">
          Applying template…
        </span>
      ) : (
        !changing && (
          <button type="submit" disabled={pending} className={`btn ${pending ? 'cursor-wait opacity-60' : ''}`}>
            {pending ? 'Starting…' : 'Apply template'}
          </button>
        )
      )}
      <Problem state={state} />
    </form>
  );
}
