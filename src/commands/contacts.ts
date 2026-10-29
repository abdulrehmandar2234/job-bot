import { getJob, normCompany, pool } from '../db.ts';
import type { Contact, ContactRole, ReferralStatus } from '../types.ts';
import type { Flags } from './shared.ts';

// Contacts are only notes the user keeps per job (who to ask for a referral); the bot never contacts anyone.
// The dashboard validates the same way (web/lib/contacts.ts).

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

const line = (c: Contact) =>
  `  #${c.id} ${c.name} (${c.role})${c.referral_status !== 'none' ? ` · referral: ${c.referral_status}` : ''}` +
  [c.email, c.linkedin_url, c.phone]
    .filter(Boolean)
    .map((x) => `\n      ${x}`)
    .join('') +
  (c.notes ? `\n      ${c.notes}` : '');

/** contacts <id>: the job's contacts, and people you know at the same company from other jobs. */
export async function contacts(args: string[]) {
  const job = args[0] ? await getJob(args[0]) : undefined;
  if (!job) return console.log('Usage: contacts <id>');
  const { rows } = await pool.query<Contact & { company: string }>(
    'SELECT c.*, j.company FROM contacts c JOIN jobs j ON j.id = c.job_id ORDER BY c.created_at, c.id',
  );
  const own = rows.filter((c) => c.job_id === job.id);
  const elsewhere = rows.filter((c) => c.job_id !== job.id && normCompany(c.company) === normCompany(job.company));
  console.log(own.length ? `Contacts for ${job.company} — ${job.title}:\n${own.map(line).join('\n')}` : 'No contacts for this job yet.');
  if (elsewhere.length) console.log(`You know someone at ${job.company} (from other jobs):\n${elsewhere.map(line).join('\n')}`);
}

/** contact:add <id> --name … [--role …] [--email …] [--linkedin …] [--phone …] [--notes …] [--referral …] */
export async function contactAdd(args: string[], flags: Flags) {
  const job = args[0] ? await getJob(args[0]) : undefined;
  if (!job)
    return console.log(
      'Usage: contact:add <id> --name "Jane Doe" [--role recruiter] [--email x] [--linkedin url] [--phone x] [--notes x] [--referral "to ask"]',
    );
  // A flag given without a value parses as 'true'; that is never a real value here.
  const f = (k: string) => (flags[k] === 'true' ? '' : flags[k]);
  const r = validateContact({
    name: f('name'),
    role: f('role'),
    email: f('email'),
    linkedin_url: f('linkedin'),
    phone: f('phone'),
    notes: f('notes'),
    referral_status: f('referral'),
  });
  if ('errors' in r) {
    console.log(`Not added:\n${r.errors.map((e) => `  - ${e}`).join('\n')}`);
    process.exitCode = 1;
    return;
  }
  const c = r.contact;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO contacts (job_id, name, role, email, linkedin_url, phone, notes, referral_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [job.id, c.name, c.role, c.email, c.linkedin_url, c.phone, c.notes, c.referral_status],
  );
  console.log(`Added contact #${rows[0].id} ${c.name} (${c.role}) to ${job.company} — ${job.title}`);
}
