import { setStatus } from '@/app/actions';
import { SKIP_LABEL, SKIP_REASONS } from '@/lib/skips';
import { ActionForm } from './action-form';

/** Skip stays one click; the optional "why?" next to it feeds the skip patterns on /analytics. */
export function SkipButton({ id }: { id: string }) {
  return (
    <ActionForm action={setStatus} fields={{ id, status: 'skipped' }} className="flex items-center gap-1" label="Skip">
      <select
        name="reason"
        defaultValue=""
        aria-label="Skip reason (optional)"
        title="Why skip? (optional)"
        data-shortcut="s"
        aria-keyshortcuts="s"
        className="input py-1 text-xs text-zinc-500"
      >
        <option value="">why? (optional)</option>
        {SKIP_REASONS.map((r) => (
          <option key={r} value={r}>
            {SKIP_LABEL[r]}
          </option>
        ))}
      </select>
    </ActionForm>
  );
}
