'use client';

import { saveApplicant } from '@/app/settings/actions';
import type { SettingsFile } from '@/lib/settings';
import { APPLICANT_FACTS, get, LETTER_FIELDS, PROFILE_FIELDS } from '@/lib/settings-form';
import { Field, input, SaveBar, Section, text, useSave } from './fields';
import { OtherEditor } from './row-editors';

const PROFILE_LABEL: Record<(typeof PROFILE_FIELDS)[number], [string, string?]> = {
  fullName: ['Full name', 'empty = name on your CV'],
  email: ['Email', 'empty = email on your CV'],
  phone: ['Phone', 'empty = phone on your CV'],
  linkedin: ['LinkedIn URL', 'empty = LinkedIn on your CV'],
  city: ['City you live in'],
  country: ['Country you live in'],
  countryCode: ['Country code', 'two letters, e.g. PT'],
  utcOffset: ['UTC offset', 'e.g. GMT+1'],
  workAuthorization: ['Work authorisation', 'citizenship, permits'],
};

const LETTER_LABEL: Record<(typeof LETTER_FIELDS)[number], [string, string]> = {
  intro: ['Introduction', 'e.g. "I am a Full Stack Engineer with 5 years of experience ..."'],
  'pitch.default': ['Pitch', 'one sentence on your strongest recent work'],
  strengths: ['How you work', 'after "Your posting asks for X, which is the core of my day-to-day work."'],
  remote: ['Remote experience', 'after "I am based in <city> (<UTC offset>)," e.g. "have worked remotely with ..."'],
};

const FACT_LABEL: Record<(typeof APPLICANT_FACTS)[number], string> = {
  currentLocation: 'Current location',
  languages: 'Languages',
  needsVisaSponsorship: 'Needs visa sponsorship',
  willingToRelocate: 'Willing to relocate',
  nationality: 'Nationality',
  noticePeriod: 'Notice period',
  earliestStartDate: 'Earliest start date',
  currentSalary: 'Current salary',
  workingHoursForRemote: 'Working hours for remote roles',
  howDidYouHear: 'How did you hear about us',
};

/** The Settings page's form for cv/applicant.json: profile, facts, letter sentences, salary and other facts. */
export function ApplicantForm({ applicant, salaryKeys = ['remote'] }: { applicant: SettingsFile; salaryKeys?: string[] }) {
  const { state, pending, onSubmit, onEdit, errors } = useSave(saveApplicant);
  const a = applicant.data;
  if (!a)
    return (
      <p role="alert" className="text-sm text-rose-700 dark:text-rose-400">
        applicant.json cannot be read ({applicant.error}). Fix it under &quot;Advanced: edit JSON&quot;.
      </p>
    );
  // Without cv/applicant.json the example person's values are only shown as placeholders, never saved as yours.
  const value = (path: string) =>
    applicant.example ? { defaultValue: '', placeholder: text(get(a, path)) } : { defaultValue: text(get(a, path)) };
  return (
    <form onSubmit={onSubmit} onChange={onEdit} aria-label="Applicant facts" className="space-y-4">
      {applicant.example && (
        <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          cv/applicant.json does not exist yet: the grey text shows an example person. Saving creates your file.
        </p>
      )}
      <p className="text-sm text-zinc-500">Leave a field empty when unknown: the AI then writes [FILL: …] instead of guessing.</p>
      <div key={applicant.text} className="space-y-4">
        <Section id="profile">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {PROFILE_FIELDS.map((k) => (
              <Field key={k} label={PROFILE_LABEL[k][0]} hint={PROFILE_LABEL[k][1]} name={k} errors={errors}>
                <input name={k} {...value(k)} className={input} />
              </Field>
            ))}
          </div>
        </Section>
        <Section id="facts">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {APPLICANT_FACTS.map((k) => (
              <Field key={k} label={FACT_LABEL[k]} name={k} errors={errors}>
                <input name={k} {...value(k)} className={input} />
              </Field>
            ))}
          </div>
        </Section>
        <Section id="cover-letter">
          <p className="text-xs text-zinc-500">Used when the AI is off or fails. Empty sentences are left out.</p>
          {LETTER_FIELDS.map((k) => (
            <Field key={k} label={LETTER_LABEL[k][0]} hint={LETTER_LABEL[k][1]} name={`coverLetter.${k}`} errors={errors}>
              <textarea name={`coverLetter.${k}`} rows={2} {...value(`coverLetter.${k}`)} className={input} />
            </Field>
          ))}
        </Section>
        <Section id="expected-salary">
          <div className="grid gap-3 sm:grid-cols-4">
            {salaryKeys.map((k) => (
              <Field key={k} label={k === 'remote' ? 'Remote' : k} name={`expectedSalary.${k}`} errors={errors}>
                <input name={`expectedSalary.${k}`} {...value(`expectedSalary.${k}`)} className={input} />
              </Field>
            ))}
          </div>
        </Section>
        <Section id="other-facts">
          <OtherEditor other={a.other} errors={errors} onEdit={onEdit} />
        </Section>
      </div>
      <SaveBar label="Save applicant facts" state={state} pending={pending} sticky />
    </form>
  );
}
