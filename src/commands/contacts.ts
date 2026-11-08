import { validateContact } from '../contacts.ts';
import { getJob, normCompany, pool } from '../db.ts';
import type { Contact } from '../types.ts';
import type { Flags } from './shared.ts';

// Contacts are only notes the user keeps per job (who to ask for a referral); the bot never contacts anyone.
// The rules for a contact (roles, validation) are in src/contacts.ts, which the dashboard imports too.
export { CONTACT_ROLES, isLinkedinUrl, REFERRAL_STATUSES, validateContact, type ContactInput } from '../contacts.ts';

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
