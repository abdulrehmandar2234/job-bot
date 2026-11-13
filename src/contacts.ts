import type { Contact, ContactRole, ReferralStatus } from './types.ts';

// The rules for contacts (people the user knows per job): roles, referral statuses, validation and the company key
// that links contacts across jobs. Pure (type imports only), so the dashboard's forms and client components use the
// same rules as `contact:add` (src/commands/contacts.ts) and dedupe (src/db.ts).

export const CONTACT_ROLES = ['recruiter', 'hiring manager', 'referral', 'other'] as const satisfies readonly ContactRole[];
export const REFERRAL_STATUSES = ['none', 'to ask', 'asked', 'agreed', 'referred'] as const satisfies readonly ReferralStatus[];

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

/** Trims and checks one contact's fields; empty optional fields become null. */
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

/** A company name as a key: "Acme Inc.", "ACME" and "acme.io" are one company (dedupe, contacts across jobs). */
export const normCompany = (s: string) =>
  s
    .toLowerCase()
    .replace(/\.(io|com|ai|co)\b/g, ' ')
    .replace(/\b([a-z])\.(?=[a-z]\b)/g, '$1') // B.V. / N.V. -> bv / nv
    .replace(
      /\b(inc|llc|ltd|limited|co|corp|corporation|gmbh|bv|b v|nv|fze|fzco|fz llc|group|technologies|technology|tech|holding|holdings|operations|solutions|labs|software|systems|global|international)\b/g,
      ' ',
    )
    .replace(/[^a-z0-9]/g, '');

/**
 * The key two company names are compared by: normCompany, or for a name it leaves empty (only symbols, or a script
 * it drops, such as Arabic) the trimmed lower-case name, so such a name still matches itself.
 */
export const companyKey = (s: string) => normCompany(s) || s.trim().toLowerCase();

/** The entry of `blocked` (config.json blockedCompanies) that names this company, or undefined. */
export function blockedBy(company: string, blocked: readonly string[] | undefined): string | undefined {
  const key = companyKey(company);
  return key ? blocked?.find((b) => companyKey(b) === key) : undefined;
}
