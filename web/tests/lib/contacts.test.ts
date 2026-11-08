import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as web from '@/lib/contacts';
import { allContacts } from '@/lib/contacts-db';
import { pool } from '@/lib/db';
import { cleanupDb, closeDb, ensureSchema, insertJob, PREFIX } from '../helpers/db';

const contact = (o: Partial<web.CompanyContact> = {}): web.CompanyContact => ({
  id: 1,
  job_id: 'j1',
  name: 'Jane',
  role: 'referral',
  email: null,
  linkedin_url: null,
  phone: null,
  notes: null,
  referral_status: 'none',
  created_at: new Date(),
  company: 'Acme',
  job_title: 'Engineer',
  ...o,
});

describe('validateContact', () => {
  it('rejects a bad email, a non-https or non-LinkedIn URL and over-long fields', () => {
    expect(web.validateContact({ name: 'J', email: 'jane@' })).toEqual({ errors: ['email is not a valid address'] });
    expect(web.validateContact({ name: 'J', email: `${'a'.repeat(250)}@b.co` })).toEqual({ errors: ['email is not a valid address'] });
    for (const url of ['http://www.linkedin.com/in/j', 'https://linkedin.com.evil.io/in/j', 'javascript:alert(1)', 'linkedin.com/in/j']) {
      expect(web.validateContact({ name: 'J', linkedin_url: url }), url).toEqual({
        errors: ['LinkedIn must be an https://…linkedin.com URL'],
      });
    }
    expect(web.validateContact({ name: 'J', linkedin_url: `https://linkedin.com/in/${'j'.repeat(300)}` })).toHaveProperty('errors');
    expect(web.validateContact({ name: 'x'.repeat(121) })).toEqual({ errors: ['name is longer than 120 characters'] });
  });

  it('accepts a full contact', () => {
    expect(
      web.validateContact({
        name: 'Jane',
        role: 'hiring manager',
        email: 'jane@acme.com',
        linkedin_url: 'https://ae.linkedin.com/in/jane',
        phone: '+971 (50) 123-4567',
        notes: 'Met at GITEX',
        referral_status: 'to ask',
      }),
    ).toEqual({
      contact: {
        name: 'Jane',
        role: 'hiring manager',
        email: 'jane@acme.com',
        linkedin_url: 'https://ae.linkedin.com/in/jane',
        phone: '+971 (50) 123-4567',
        notes: 'Met at GITEX',
        referral_status: 'to ask',
      },
    });
  });
});

describe('company-level lookup', () => {
  it("splits contacts at the same normalized company into this job's own and other jobs'", () => {
    const all = [
      contact({ id: 1, job_id: 'j1' }),
      contact({ id: 2, job_id: 'j2', company: 'ACME Inc.' }),
      contact({ id: 3, job_id: 'j3', company: 'Other' }),
    ];
    const r = web.contactsFor({ id: 'j1', company: 'acme.io' }, all);
    expect(r.own.map((c) => c.id)).toEqual([1]);
    expect(r.elsewhere.map((c) => c.id)).toEqual([2]);
  });

  it('never matches a company that normalizes to nothing', () => {
    expect(web.contactsFor({ id: 'j9', company: 'Inc.' }, [contact({ company: 'LLC' })])).toEqual({ own: [], elsewhere: [] });
  });
});

describe('referralReminder', () => {
  const job = { id: 'j1', company: 'Acme', status: 'new' as const };

  it('names a contact at the company whose referral is not asked for yet, "to ask" first', () => {
    const all = [contact({ id: 1, name: 'Ann' }), contact({ id: 2, name: 'Bob', job_id: 'j2', referral_status: 'to ask' })];
    expect(web.referralReminder(job, all)?.name).toBe('Bob');
    expect(web.referralReminder(job, [all[0]])?.name).toBe('Ann');
  });

  it('is quiet once asked, for other companies, and after applying', () => {
    for (const s of ['asked', 'agreed', 'referred'] as const)
      expect(web.referralReminder(job, [contact({ referral_status: s })])).toBeNull();
    expect(web.referralReminder(job, [contact({ company: 'Other' })])).toBeNull();
    expect(web.referralReminder({ ...job, status: 'prepared' }, [contact()])).not.toBeNull();
    for (const status of ['applied', 'interview', 'skipped', 'filtered'] as const) {
      expect(web.referralReminder({ ...job, status }, [contact()])).toBeNull();
    }
  });
});

describe('allContacts', () => {
  beforeAll(ensureSchema);
  beforeEach(cleanupDb);
  afterAll(closeDb);

  it("returns every contact with its job's company and title", async () => {
    const id = await insertJob({ id: 'lc-1', company: 'Acme Inc.', title: 'Backend Engineer' });
    await pool.query(`INSERT INTO contacts (job_id, name, role) VALUES ($1, 'Jane', 'recruiter'), ($1, 'Sam', 'referral')`, [id]);
    const rows = (await allContacts()).filter((c) => c.job_id.startsWith(PREFIX));
    expect(rows.map((c) => [c.name, c.role, c.company, c.job_title, c.referral_status])).toEqual([
      ['Jane', 'recruiter', 'Acme Inc.', 'Backend Engineer', 'none'],
      ['Sam', 'referral', 'Acme Inc.', 'Backend Engineer', 'none'],
    ]);
  });
});
