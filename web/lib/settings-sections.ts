/**
 * The Settings page's sections, in page order: the cards in components/settings.tsx take their id and title from here,
 * and the section nav in components/settings-nav.tsx links to each id, so the two cannot drift apart.
 */
export const SETTINGS_GROUPS = [
  {
    id: 'search-settings',
    title: 'Search settings',
    sections: [
      { id: 'matching', title: 'Matching' },
      { id: 'countries', title: 'Target countries' },
      { id: 'linkedin', title: 'LinkedIn' },
      { id: 'remote-boards', title: 'Remote boards' },
      { id: 'adzuna', title: 'Adzuna' },
      { id: 'ai-review', title: 'AI review' },
      { id: 'companies', title: 'Companies (careers pages)' },
      { id: 'config-json', title: 'Advanced: edit JSON' },
    ],
  },
  {
    id: 'applicant-settings',
    title: 'Your profile and applicant facts',
    sections: [
      { id: 'profile', title: 'Profile' },
      { id: 'facts', title: 'Facts' },
      { id: 'cover-letter', title: 'Template cover letter' },
      { id: 'expected-salary', title: 'Expected salary' },
      { id: 'other-facts', title: 'Other facts' },
      { id: 'applicant-json', title: 'Advanced: edit JSON' },
    ],
  },
] as const;

export type SettingsSectionId = (typeof SETTINGS_GROUPS)[number]['sections'][number]['id'];

const TITLES = Object.fromEntries(SETTINGS_GROUPS.flatMap((g) => g.sections.map((s) => [s.id, s.title]))) as Record<
  SettingsSectionId,
  string
>;

export const sectionTitle = (id: SettingsSectionId) => TITLES[id];
