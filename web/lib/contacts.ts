import type { Status } from '@/lib/db';
import type { Contact, ContactRole, ReferralStatus } from '../../src/types';

// Contacts per job: only what the user typed in; nothing here ever contacts anyone.
// Pure helpers, safe for client components; the query is in lib/contacts-db.ts.
// The bot's copies of these rules live in src/db.ts (normCompany) and src/commands/contacts.ts;
// tests/lib/contacts.test.ts checks they agree, since bot code cannot be imported at runtime here.

export type { Contact, ContactRole, ReferralStatus };

export const CONTACT_ROLES = ['recruiter', 'hiring manager', 'referral', 'other'] as const satisfies readonly ContactRole[];
export const REFERRAL_STATUSES = ['none', 'to ask', 'asked', 'agreed', 'referred'] as const satisfies readonly ReferralStatus[];

/** Same as the bot's normCompany (src/db.ts): "Acme Inc." and "ACME" are one company. */
export const normCompany = (s: string) => s.toLowerCase()
  .replace(/\.(io|com|ai|co)\b/g, ' ')
  .replace(/\b([a-z])\.(?=[a-z]\b)/g, '$1') // B.V. / N.V. -> bv / nv
  .replace(/\b(inc|llc|ltd|limited|co|corp|corporation|gmbh|bv|b v|nv|fze|fzco|fz llc|group|technologies|technology|tech|holding|holdings|operations|solutions|labs|software|systems|global|international)\b/g, ' ')
  .replace(/[^a-z0-9]/g, '');

export type ContactInput = Pick<Contact, 'name' | 'role' | 'email' | 'linkedin_url' | 'phone' | 'notes' | 'referral_status'>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[\d\s().-]{3,40}$/;

/** An https URL on linkedin.com (or a subdomain such as www. or ae.). */
export function isLinkedinUrl(s: string) {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && /(^|\.)linkedin\.com$/.test(u.hostname);
  } catch {
    return false;
  }
}

/** Trims and checks one contact's fields; empty optional fields become null. Same rules as the bot's contact:add. */
export function validateContact(raw: Record<string, string | undefined>): { contact: ContactInput } | { errors: string[] } {
  const v = (k: string) => raw[k]?.trim() || null;
  const errors: string[] = [];
  const name = v('name');
  const role = (v('role') ?? 'other') as ContactRole;
  const referral = (v('referral_status') ?? 'none') as ReferralStatus;
  const [email, linkedin, phone, notes] = [v('email'), v('linkedin_url'), v('phone'), v('notes')];
  if (!name) errors.push('name is required');
  else if (name.length > 120) errors.push('name is longer than 120 characters');
  if (!CONTACT_ROLES.includes(role)) errors.push(`role must be one of: ${CONTACT_ROLES.join(', ')}`);
  if (!REFERRAL_STATUSES.includes(referral)) errors.push(`referral status must be one of: ${REFERRAL_STATUSES.join(', ')}`);
  if (email && (email.length > 254 || !EMAIL.test(email))) errors.push('email is not a valid address');
  if (linkedin && (linkedin.length > 300 || !isLinkedinUrl(linkedin))) errors.push('LinkedIn must be an https://…linkedin.com URL');
  if (phone && !PHONE.test(phone)) errors.push('phone may only contain digits, spaces and + ( ) . -');
  if (notes && notes.length > 2000) errors.push('notes are longer than 2000 characters');
  if (errors.length) return { errors };
  return { contact: { name: name!, role, email, linkedin_url: linkedin, phone, notes, referral_status: referral } };
}

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
  return [...own, ...elsewhere].filter((c) => ASK.includes(c.referral_status))
    .sort((a, b) => ASK.indexOf(a.referral_status) - ASK.indexOf(b.referral_status))[0] ?? null;
}
