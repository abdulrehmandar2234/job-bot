import { connection } from 'next/server';
import { ApplicantForm, ConfigForm, JsonEditor } from '@/components/settings';
import { SettingsNav } from '@/components/settings-nav';
import { salaryKeys } from '@/lib/settings-form';
import { SETTINGS_GROUPS } from '@/lib/settings-sections';
import { aiKeyStatus, readApplicant, readConfig } from '@/lib/settings';

/** Reads both files on every request: they change outside the dashboard too. */
export async function Settings() {
  await connection();
  const config = readConfig();
  const applicant = readApplicant();
  const [search, profile] = SETTINGS_GROUPS;
  return (
    <div className="mt-4 grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-8">
      <SettingsNav />
      <div className="min-w-0 space-y-10">
        <section id={search.id} aria-labelledby={`${search.id}-title`} className="scroll-mt-4 space-y-4">
          <div>
            <h2 id={`${search.id}-title`} className="text-lg font-semibold">
              {search.title}
            </h2>
            <p className="text-sm text-zinc-500">config.json · saving re-scores the stored jobs with the new filters.</p>
          </div>
          <ConfigForm config={config} keys={aiKeyStatus()} />
          <JsonEditor kind="config" file={config} />
        </section>
        <section id={profile.id} aria-labelledby={`${profile.id}-title`} className="scroll-mt-4 space-y-4">
          <div>
            <h2 id={`${profile.id}-title`} className="text-lg font-semibold">
              {profile.title}
            </h2>
            <p className="text-sm text-zinc-500">
              cv/applicant.json · signs your cover letters and follow-ups, and tells the AI and the filters who you are.
            </p>
          </div>
          <ApplicantForm applicant={applicant} salaryKeys={salaryKeys(config.data)} />
          <JsonEditor kind="applicant" file={applicant} />
        </section>
      </div>
    </div>
  );
}
