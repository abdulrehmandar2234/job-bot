import { connection } from 'next/server';
import { ApplicantForm, ConfigForm, JsonEditor } from '@/components/settings';
import { salaryKeys } from '@/lib/settings-form';
import { aiKeyStatus, readApplicant, readConfig } from '@/lib/settings';

/** Reads both files on every request: they change outside the dashboard too. */
export async function Settings() {
  await connection();
  const config = readConfig();
  const applicant = readApplicant();
  return (
    <div className="mt-4 space-y-10">
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Search settings</h2>
          <p className="text-sm text-zinc-500">config.json · saving re-scores the stored jobs with the new filters.</p>
        </div>
        <ConfigForm config={config} keys={aiKeyStatus()} />
        <JsonEditor kind="config" file={config} />
      </section>
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Your profile and applicant facts</h2>
          <p className="text-sm text-zinc-500">
            cv/applicant.json · signs your cover letters and follow-ups, and tells the AI and the filters who you are.
          </p>
        </div>
        <ApplicantForm applicant={applicant} salaryKeys={salaryKeys(config.data)} />
        <JsonEditor kind="applicant" file={applicant} />
      </section>
    </div>
  );
}
