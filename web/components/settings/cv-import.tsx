import { applyCvImport, discardCvImport, importCv } from '@/app/settings/actions';
import { ActionForm } from '@/components/action-form';
import { TaskBar } from '@/components/tasks';
import { ConfirmFirst } from '@/components/written-text';
import { IMPORT_TYPES } from '@/lib/cv-import';
import type { TaskView } from '@/lib/tasks';
import type { ImportDraft } from '../../../src/cv/import.ts';

/**
 * "Import your CV" on the Settings page: upload a CV, the AI turns it into a draft master CV (a background task), and
 * the draft is shown for review with "Use this as my CV" and "Discard". cv/master.json changes only on "Use".
 */
export function CvImport({ draft, error, tasks }: { draft: ImportDraft | null; error: string | null; tasks: TaskView[] }) {
  const running = tasks.some((t) => t.status === 'queued' || t.status === 'running');
  return (
    <section aria-labelledby="cv-import-title" className="space-y-3 rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800">
      <div>
        <h3 id="cv-import-title" className="font-medium">
          Import your CV
        </h3>
        <p className="text-zinc-500">
          Upload your current CV ({IMPORT_TYPES.join(', ')}) and the AI fills in cv/master.json from it: only what the file says, and skills
          that are not in it are left out. You check the draft before it replaces your master CV.
        </p>
      </div>
      <TaskBar tasks={tasks} />
      {!running && (
        <ActionForm action={importCv} className="flex flex-wrap items-center gap-2" pendingText="Uploading…" label="Import CV">
          <input type="file" name="cv" accept={IMPORT_TYPES.join(',')} aria-label="CV file" className="text-sm" />
        </ActionForm>
      )}
      {error && (
        <p role="alert" className="text-rose-700 dark:text-rose-400">
          {error}
        </p>
      )}
      {draft && <Draft draft={draft} />}
    </section>
  );
}

function Draft({ draft }: { draft: ImportDraft }) {
  const { cv, dropped, warnings } = draft;
  const skills = cv.skills.reduce((n, g) => n + g.items.length, 0);
  return (
    <div className="space-y-2 rounded-lg border border-sky-200 bg-sky-50 p-3 dark:border-sky-900 dark:bg-sky-950/30">
      <p className="font-medium">
        Draft from {draft.source}: {cv.name}
        {cv.title && `, ${cv.title}`}
      </p>
      <p>
        {cv.experience.length} job{cv.experience.length === 1 ? '' : 's'}, {skills} skill{skills === 1 ? '' : 's'}, {cv.projects.length}{' '}
        project{cv.projects.length === 1 ? '' : 's'}, {cv.education.length} education
      </p>
      {dropped.length > 0 && (
        <p>
          <span className="font-medium">Left out</span> (not in your file): {dropped.join(', ')}
        </p>
      )}
      {warnings.length > 0 && (
        <ul className="list-disc pl-5 text-amber-800 dark:text-amber-300">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <details>
        <summary className="cursor-pointer">Read the whole draft</summary>
        <pre className="mt-2 max-h-96 overflow-auto rounded bg-white p-2 text-xs dark:bg-zinc-900">{JSON.stringify(cv, null, 2)}</pre>
      </details>
      <p className="text-zinc-600 dark:text-zinc-400">
        Using it replaces cv/master.json (the current one is kept in data/cv-backups). Fix small things afterwards in the file itself.
      </p>
      <div className="flex flex-wrap gap-2">
        <ConfirmFirst message="Replace your master CV (cv/master.json) with this draft? The current one is backed up first.">
          <ActionForm action={applyCvImport} pendingText="Saving…" label="Use this as my CV" buttonClass="btn-primary" />
        </ConfirmFirst>
        <ActionForm action={discardCvImport} pendingText="…" label="Discard" />
      </div>
    </div>
  );
}
