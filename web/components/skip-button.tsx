import { setStatus } from '@/app/actions';
import { SKIP_LABEL, SKIP_REASONS } from '@/lib/skips';
import { SubmitButton } from './client';

/** Skip stays one click; the optional "why?" next to it feeds the skip patterns on /analytics. */
export function SkipButton({ id }: { id: string }) {
  return (
    <form action={setStatus} className="flex items-center gap-1">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="status" value="skipped" />
      <select name="reason" defaultValue="" aria-label="Skip reason (optional)" title="Why skip? (optional)"
        className="input py-1 text-xs text-zinc-500">
        <option value="">why? (optional)</option>
        {SKIP_REASONS.map((r) => <option key={r} value={r}>{SKIP_LABEL[r]}</option>)}
      </select>
      <SubmitButton>Skip</SubmitButton>
    </form>
  );
}
