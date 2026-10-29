import { pool } from '@/lib/db';
import type { CompanyContact } from '@/lib/contacts';

/** Every contact with its job's company. The table holds what one person typed in, so it stays small. */
export async function allContacts() {
  const { rows } = await pool.query<CompanyContact>(
    `SELECT c.*, j.company, j.title AS job_title FROM contacts c JOIN jobs j ON j.id = c.job_id ORDER BY c.created_at, c.id`,
  );
  return rows;
}
