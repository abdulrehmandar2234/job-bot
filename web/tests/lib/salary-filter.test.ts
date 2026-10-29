import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listJobs } from '@/lib/db';
import { yearlyEur } from '@/lib/salary';
import { cleanupDb, closeDb, ensureSchema, insertJob, ours, PREFIX } from '../helpers/db';

beforeAll(ensureSchema);
beforeEach(cleanupDb);
afterAll(closeDb);

// Roughly EUR 60k a year each, in different currencies and periods, plus lower and missing ones.
async function seed() {
  await insertJob({ id: 'sal-aed', salary_min: 18_000, salary_max: 22_000, salary_currency: 'AED', salary_period: 'month' }); // 66k
  await insertJob({ id: 'sal-eur', salary_min: 4_000, salary_max: 4_500, salary_currency: 'EUR', salary_period: 'month' });  // 54k
  await insertJob({ id: 'sal-usd', salary_min: null, salary_max: 90_000, salary_currency: 'USD', salary_period: 'year' });   // 82.8k
  await insertJob({ id: 'sal-pkr', salary_min: 400_000, salary_max: 600_000, salary_currency: 'PKR', salary_period: 'month' }); // 23.8k
  await insertJob({ id: 'sal-hour', salary_min: 30, salary_max: 35, salary_currency: 'GBP', salary_period: 'hour' });        // 85k
  await insertJob({ id: 'sal-none' });
}
const ids = (rows: { id: string }[]) => ours(rows).map((id) => id.slice(PREFIX.length)).sort();

describe('listJobs salary filter', () => {
  it('compares the top of each range in euros per year, and keeps jobs without a salary', async () => {
    await seed();
    expect(ids(await listJobs({ status: 'new', minSalary: 60_000 }))).toEqual(['sal-aed', 'sal-hour', 'sal-none', 'sal-usd']);
    expect(ids(await listJobs({ status: 'new', minSalary: 80_000 }))).toEqual(['sal-hour', 'sal-none', 'sal-usd']);
  });

  it('gives the same result for the same amount typed in another currency or period', async () => {
    await seed();
    const eur = ids(await listJobs({ status: 'new', minSalary: yearlyEur(5_000, 'EUR', 'month') }));
    const aed = ids(await listJobs({ status: 'new', minSalary: yearlyEur(240_000, 'AED', 'year') }));
    expect(eur).toEqual(['sal-aed', 'sal-hour', 'sal-none', 'sal-usd']);
    expect(aed).toEqual(eur);
  });

  it('"only with salary" hides jobs without one, with or without a minimum', async () => {
    await seed();
    expect(ids(await listJobs({ status: 'new', salaryOnly: true }))).toEqual(['sal-aed', 'sal-eur', 'sal-hour', 'sal-pkr', 'sal-usd']);
    expect(ids(await listJobs({ status: 'new', minSalary: 60_000, salaryOnly: true }))).toEqual(['sal-aed', 'sal-hour', 'sal-usd']);
  });

  it('returns the salary columns', async () => {
    await seed();
    const j = (await listJobs({ status: 'new' })).find((r) => r.id === `${PREFIX}sal-aed`)!;
    expect([j.salary_min, j.salary_max, j.salary_currency, j.salary_period]).toEqual([18_000, 22_000, 'AED', 'month']);
  });
});
