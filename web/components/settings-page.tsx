import { connection } from 'next/server';
import { ApplicantForm, ConfigForm, JsonEditor } from '@/components/settings';
import { salaryKeys } from '@/lib/settings-form';
import { SETTINGS_GROUPS } from '@/lib/settings-sections';
import { aiKeyStatus, readApplicant, readConfig } from '@/lib/settings';

const navLink =
  'block rounded-lg px-2.5 py-1 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100';

/**
 * Links to every section: a sticky column on the left on large screens, a wrapped list of links above the forms on
 * small ones. Plain anchors, so it needs no client JS.
 */
export function SettingsNav() {
  return (
    <nav aria-label="Settings sections" className="text-sm lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
        {SETTINGS_GROUPS.map((g) => (
          <div key={g.id}>
            <a href={`#${g.id}`} className="mb-1 block px-2.5 text-xs font-semibold tracking-wide text-zinc-500 uppercase hover:underline">
              {g.title}
            </a>
            <ul className="flex flex-wrap gap-x-1 lg:block lg:space-y-0.5">
              {g.sections.map((s) => (
                <li key={s.id}>
                  <a href={`#${s.id}`} className={navLink}>
                    {s.title}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}

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
