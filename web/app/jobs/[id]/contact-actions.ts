'use server';

import { refresh } from 'next/cache';
import { pool } from '@/lib/db';
import { validateContact } from '@/lib/contacts';

// Contacts on the job page. They only store what the user typed; nothing here sends a message to anyone.
// Server actions are reachable by POST, so the job id, contact id and every field are checked here.

export type ContactState = { ok: boolean; errors: string[] } | null;

async function assertJob(id: unknown): Promise<string> {
  if (typeof id !== 'string' || !id) throw new Error('Missing job id');
  const { rowCount } = await pool.query('SELECT 1 FROM jobs WHERE id = $1', [id]);
  if (!rowCount) throw new Error('Unknown job');
  return id;
}

/** A contact id from the form, as a positive integer. */
function contactId(v: FormDataEntryValue | null): number {
  const n = Number(v);
  if (typeof v !== 'string' || !/^\d+$/.test(v) || !Number.isSafeInteger(n) || n < 1) throw new Error('Invalid contact id');
  return n;
}

const fields = (fd: FormData) => Object.fromEntries(['name', 'role', 'email', 'linkedin_url', 'phone', 'notes', 'referral_status']
  .map((k) => { const v = fd.get(k); return [k, typeof v === 'string' ? v : undefined]; }));

/** Adds a contact, or updates one when the form has `contact_id`. Validation errors come back to the form. */
export async function saveContact(_prev: ContactState, fd: FormData): Promise<ContactState> {
  const jobId = await assertJob(fd.get('id'));
  const r = validateContact(fields(fd));
  if ('errors' in r) return { ok: false, errors: r.errors };
  const c = r.contact;
  const values = [c.name, c.role, c.email, c.linkedin_url, c.phone, c.notes, c.referral_status];
  if (fd.get('contact_id') == null) {
    await pool.query(`INSERT INTO contacts (job_id, name, role, email, linkedin_url, phone, notes, referral_status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [jobId, ...values]);
  } else {
    // The contact must belong to this job, so a forged form cannot edit another job's contact.
    const { rowCount } = await pool.query(`UPDATE contacts SET name = $3, role = $4, email = $5, linkedin_url = $6, phone = $7,
      notes = $8, referral_status = $9 WHERE id = $1 AND job_id = $2`, [contactId(fd.get('contact_id')), jobId, ...values]);
    if (!rowCount) throw new Error('Unknown contact');
  }
  refresh();
  return { ok: true, errors: [] };
}

export async function deleteContact(fd: FormData) {
  const jobId = await assertJob(fd.get('id'));
  const { rowCount } = await pool.query('DELETE FROM contacts WHERE id = $1 AND job_id = $2', [contactId(fd.get('contact_id')), jobId]);
  if (!rowCount) throw new Error('Unknown contact');
  refresh();
}
