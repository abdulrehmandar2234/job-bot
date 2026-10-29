import { refresh } from 'next/cache';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteContact, saveContact } from '@/app/jobs/[id]/contact-actions';
import { pool } from '@/lib/db';
import { cleanupDb, closeDb, ensureSchema, insertJob, PREFIX } from '../../helpers/db';

vi.mock('next/cache', () => ({ refresh: vi.fn() }));

const id = PREFIX + 'contacts';
const other = PREFIX + 'contacts-other';
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const rows = async () =>
  (
    await pool.query(
      'SELECT id, job_id, name, role, email, linkedin_url, phone, notes, referral_status FROM contacts WHERE job_id LIKE $1 ORDER BY id',
      [`${PREFIX}%`],
    )
  ).rows;

beforeAll(ensureSchema);
beforeEach(async () => {
  await cleanupDb();
  await insertJob({ id });
  await insertJob({ id: other });
  vi.clearAllMocks();
});
afterAll(closeDb);

describe('saveContact', () => {
  it('adds a contact with trimmed fields and refreshes', async () => {
    const res = await saveContact(
      null,
      form({
        id,
        name: '  Jane Doe ',
        role: 'recruiter',
        email: 'jane@acme.com',
        linkedin_url: 'https://www.linkedin.com/in/jane',
        phone: '',
        notes: ' met at GITEX ',
        referral_status: 'to ask',
      }),
    );
    expect(res).toEqual({ ok: true, errors: [] });
    expect(await rows()).toEqual([
      expect.objectContaining({
        job_id: id,
        name: 'Jane Doe',
        role: 'recruiter',
        email: 'jane@acme.com',
        linkedin_url: 'https://www.linkedin.com/in/jane',
        phone: null,
        notes: 'met at GITEX',
        referral_status: 'to ask',
      }),
    ]);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('returns validation errors and stores nothing for a bad email or LinkedIn URL', async () => {
    const res = await saveContact(null, form({ id, name: 'Jane', email: 'jane@', linkedin_url: 'http://linkedin.com/in/jane' }));
    expect(res).toEqual({ ok: false, errors: ['email is not a valid address', 'LinkedIn must be an https://…linkedin.com URL'] });
    expect(await saveContact(null, form({ id, name: 'x'.repeat(121) }))).toMatchObject({ ok: false });
    expect(await saveContact(null, form({ id, name: 'J', role: 'boss' }))).toMatchObject({ ok: false });
    expect(await rows()).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('edits a contact of the same job', async () => {
    await saveContact(null, form({ id, name: 'Jane' }));
    const [c] = await rows();
    await saveContact(null, form({ id, contact_id: String(c.id), name: 'Jane D', role: 'referral', referral_status: 'asked' }));
    expect(await rows()).toEqual([expect.objectContaining({ id: c.id, name: 'Jane D', role: 'referral', referral_status: 'asked' })]);
  });

  it('checks the job id and that the contact belongs to the job', async () => {
    await expect(saveContact(null, form({ name: 'J' }))).rejects.toThrow('Missing job id');
    await expect(saveContact(null, form({ id: PREFIX + 'nope', name: 'J' }))).rejects.toThrow('Unknown job');
    await saveContact(null, form({ id: other, name: 'Theirs' }));
    const [c] = await rows();
    await expect(saveContact(null, form({ id, contact_id: String(c.id), name: 'Mine' }))).rejects.toThrow('Unknown contact');
    for (const bad of ['abc', '1.5', '-1', '0', '1e3']) {
      await expect(saveContact(null, form({ id, contact_id: bad, name: 'J' })), bad).rejects.toThrow('Invalid contact id');
    }
    expect((await rows()).map((r) => r.name)).toEqual(['Theirs']);
  });
});

describe('deleteContact', () => {
  it('deletes only a contact of the given job', async () => {
    await saveContact(null, form({ id, name: 'Mine' }));
    await saveContact(null, form({ id: other, name: 'Theirs' }));
    const [mine, theirs] = await rows();
    await expect(deleteContact(form({ id, contact_id: String(theirs.id) }))).rejects.toThrow('Unknown contact');
    await expect(deleteContact(form({ id }))).rejects.toThrow('Invalid contact id');
    await expect(deleteContact(form({ contact_id: String(mine.id) }))).rejects.toThrow('Missing job id');
    vi.clearAllMocks();
    await deleteContact(form({ id, contact_id: String(mine.id) }));
    expect((await rows()).map((r) => r.name)).toEqual(['Theirs']);
    expect(refresh).toHaveBeenCalledOnce();
  });
});
