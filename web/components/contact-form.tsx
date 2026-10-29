'use client';

import { useActionState } from 'react';
import { saveContact } from '@/app/jobs/[id]/contact-actions';
import { CONTACT_ROLES, REFERRAL_STATUSES, type Contact } from '@/lib/contacts';
import { SubmitButton } from './client';

/** Add a contact (no `contact`) or edit one. Only stores what you type; nobody is contacted. */
export function ContactForm({ jobId, contact }: { jobId: string; contact?: Contact }) {
  const [state, action] = useActionState(saveContact, null);
  const c = contact;
  return (
    <form action={action} className="grid gap-2 sm:grid-cols-2">
      <input type="hidden" name="id" value={jobId} />
      {c && <input type="hidden" name="contact_id" value={c.id} />}
      <input name="name" defaultValue={c?.name} required maxLength={120} placeholder="Name" aria-label="Name" className="input" />
      <select name="role" defaultValue={c?.role ?? 'recruiter'} aria-label="Role" className="input">
        {CONTACT_ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <input
        name="email"
        type="email"
        defaultValue={c?.email ?? ''}
        maxLength={254}
        placeholder="Email"
        aria-label="Email"
        className="input"
      />
      <input
        name="linkedin_url"
        type="url"
        defaultValue={c?.linkedin_url ?? ''}
        maxLength={300}
        pattern="https://.*"
        placeholder="https://www.linkedin.com/in/…"
        aria-label="LinkedIn URL"
        className="input"
      />
      <input
        name="phone"
        type="tel"
        defaultValue={c?.phone ?? ''}
        maxLength={40}
        placeholder="Phone"
        aria-label="Phone"
        className="input"
      />
      <label className="flex items-center gap-2 text-sm text-zinc-500">
        Referral
        <select name="referral_status" defaultValue={c?.referral_status ?? 'none'} className="input flex-1">
          {REFERRAL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <textarea
        name="notes"
        defaultValue={c?.notes ?? ''}
        maxLength={2000}
        rows={2}
        placeholder="Notes (how you know them, …)"
        aria-label="Notes"
        className="input sm:col-span-2"
      />
      <div className="flex items-center gap-3 sm:col-span-2">
        <SubmitButton pendingText="Saving…">{c ? 'Save contact' : 'Add contact'}</SubmitButton>
        {state?.ok && (
          <span role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
            Saved.
          </span>
        )}
      </div>
      {state && !state.ok && (
        <ul role="alert" className="list-disc pl-5 text-sm text-rose-700 dark:text-rose-400 sm:col-span-2">
          {state.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
    </form>
  );
}
