import { SKIP_REASONS, type SkipReason } from '../../src/types.ts';

// Why a job was skipped (job_events.reason): the bot's list, with the dashboard's labels.
export { SKIP_REASONS, type SkipReason };

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
