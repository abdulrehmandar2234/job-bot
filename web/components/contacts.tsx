import Link from 'next/link';
import { deleteContact } from '@/app/jobs/[id]/contact-actions';
import { contactsFor, referralReminder, type CompanyContact } from '@/lib/contacts';
import type { Status } from '@/lib/db';
import { SubmitButton } from './client';
import { ContactForm } from './contact-form';

type JobRef = { id: string; company: string; status: Status };

/** "Ask <name> for a referral before applying", on jobs you have not applied to yet. */
export function ReferralReminder({ job, contacts }: { job: JobRef; contacts: CompanyContact[] }) {
  const c = referralReminder(job, contacts);
  if (!c) return null;
  return (
    <p className="rounded-lg border border-sky-300 bg-sky-50 p-3 text-sm text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200">
      🤝 Ask <b>{c.name}</b> for a referral before applying
      {c.job_id !== job.id && <span className="text-sky-700 dark:text-sky-400"> (you added them on {c.job_title})</span>}.
    </p>
  );
}

/** The same reminder as a small tag for the job list card. */
export function ReferralBadge({ job, contacts }: { job: JobRef; contacts: CompanyContact[] }) {
  const c = referralReminder(job, contacts);
  if (!c) return null;
  return (
    <span title={`Ask ${c.name} for a referral before applying`}
      className="inline-block rounded-full border border-sky-300 px-2 py-0.5 text-xs text-sky-700 dark:border-sky-800 dark:text-sky-300">
      🤝 Ask {c.name} for a referral
    </span>
  );
}

function ContactLine({ c }: { c: CompanyContact }) {
  return (
    <div className="space-y-0.5">
      <p><b>{c.name}</b> <span className="text-zinc-500">· {c.role}</span>
        {c.referral_status !== 'none' && <span className="text-zinc-500"> · referral: {c.referral_status}</span>}</p>
      <p className="flex flex-wrap gap-x-3 text-xs text-zinc-500">
        {c.email && <a href={`mailto:${c.email}`} className="hover:underline">{c.email}</a>}
        {c.linkedin_url && <a href={c.linkedin_url} target="_blank" rel="noreferrer" className="hover:underline">LinkedIn ↗</a>}
        {c.phone && <span>{c.phone}</span>}
      </p>
      {c.notes && <p className="whitespace-pre-line text-xs text-zinc-500">{c.notes}</p>}
    </div>
  );
}

/** Contacts for one job: add, edit and delete, plus people you know at the same company from other jobs. */
export function Contacts({ job, contacts }: { job: JobRef; contacts: CompanyContact[] }) {
  const { own, elsewhere } = contactsFor(job, contacts);
  return (
    <section className="space-y-3">
      <h2 className="font-medium">
        Contacts <span className="text-xs font-normal text-zinc-500">· recruiters and referrals you know; only stored here, nobody is contacted</span>
      </h2>
      {elsewhere.length > 0 && (
        <div className="space-y-2 rounded-xl border border-sky-200 p-3 text-sm dark:border-sky-900">
          <p className="font-medium">You know someone at {job.company}</p>
          <ul className="space-y-2">
            {elsewhere.map((c) => (
              <li key={c.id}>
                <ContactLine c={c} />
                <Link href={`/jobs/${encodeURIComponent(c.job_id)}`} className="text-xs text-sky-700 hover:underline dark:text-sky-400">
                  added on {c.job_title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {own.length > 0 && (
        <ul className="space-y-2">
          {own.map((c) => (
            <li key={c.id} className="space-y-2 rounded-xl border border-zinc-200 p-3 text-sm dark:border-zinc-800">
              <div className="flex items-start justify-between gap-3">
                <ContactLine c={c} />
                <form action={deleteContact}>
                  <input type="hidden" name="id" value={job.id} />
                  <input type="hidden" name="contact_id" value={c.id} />
                  <SubmitButton pendingText="Deleting…">Delete</SubmitButton>
                </form>
              </div>
              <details>
                <summary className="cursor-pointer text-xs text-zinc-500">Edit</summary>
                <div className="mt-2"><ContactForm jobId={job.id} contact={c} /></div>
              </details>
            </li>
          ))}
        </ul>
      )}
      <details className="rounded-xl border border-dashed border-zinc-300 p-3 text-sm dark:border-zinc-700">
        <summary className="cursor-pointer font-medium">Add contact</summary>
        <div className="mt-3"><ContactForm jobId={job.id} /></div>
      </details>
    </section>
  );
}
