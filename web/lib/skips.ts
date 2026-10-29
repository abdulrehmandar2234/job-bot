import type { SkipReason } from '../../src/types';

// Why a job was skipped (job_events.reason). Same list as the bot's SKIP_REASONS (src/db.ts); tests/lib/skips.test.ts checks.
export type { SkipReason };

export const SKIP_REASONS = [
  'stack',
  'seniority',
  'salary',
  'location',
  'company',
  'language',
  'other',
] as const satisfies readonly SkipReason[];

export const SKIP_LABEL: Record<SkipReason, string> = {
  stack: 'Stack',
  seniority: 'Seniority',
  salary: 'Salary',
  location: 'Location / visa',
  company: 'Company',
  language: 'Language',
  other: 'Other',
};

/** The reason from a form, or null when none (or an unknown one) was picked. */
export const skipReason = (v: unknown): SkipReason | null => (SKIP_REASONS.includes(v as SkipReason) ? (v as SkipReason) : null);
