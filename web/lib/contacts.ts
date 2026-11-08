import type { Status } from '@/lib/db';
import type { Contact, ReferralStatus } from '../../src/types.ts';
import { normCompany } from '../../src/contacts.ts';

// Contacts per job: only what the user typed in; nothing here ever contacts anyone.
// Pure helpers, safe for client components; the query is in lib/contacts-db.ts. The rules for one contact (roles,
// validation, the company key) are the bot's own, src/contacts.ts.

export {
  CONTACT_ROLES,
  isLinkedinUrl,
  normCompany,
  REFERRAL_STATUSES,
  validateContact,
  type ContactInput,
} from '../../src/contacts.ts';
export type { Contact, ContactRole, ReferralStatus } from '../../src/types.ts';

/** A contact plus the job it was added to (lib/contacts-db.ts). */
export type CompanyContact = Contact & { company: string; job_title: string };

/** Contacts at the same company as `company`, grouped into this job's own and those added to other jobs. */
export function contactsFor(job: { id: string; company: string }, all: CompanyContact[]) {
  const key = normCompany(job.company);
  const same = all.filter((c) => key && normCompany(c.company) === key);
  return { own: same.filter((c) => c.job_id === job.id), elsewhere: same.filter((c) => c.job_id !== job.id) };
}

const ASK: readonly ReferralStatus[] = ['to ask', 'none'];

/**
 * Who to ask for a referral before applying: on a job you have not applied to yet (new / prepared), a contact
 * at the same company whose referral is not asked for yet. "To ask" ones come first, then this job's own.
 */
export function referralReminder(job: { id: string; company: string; status: Status }, all: CompanyContact[]) {
  if (job.status !== 'new' && job.status !== 'prepared') return null;
  const { own, elsewhere } = contactsFor(job, all);
  return (
    [...own, ...elsewhere]
      .filter((c) => ASK.includes(c.referral_status))
      .sort((a, b) => ASK.indexOf(a.referral_status) - ASK.indexOf(b.referral_status))[0] ?? null
  );
}
