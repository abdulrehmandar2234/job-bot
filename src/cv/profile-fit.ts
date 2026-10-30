import { masterText, unsupportedClaims } from './feedback.ts';
import { PROFILES, type Profile } from './profiles.ts';
import type { Cv } from './render.ts';

// The profiles in profiles.ts were written for the owner's master CV: their titles and summaries name its skills,
// employers, numbers and projects. Another user's CV may only take a profile's text when everything it names is on
// that user's cv/master.json; otherwise the version keeps the master's own title and summary (the profile's
// orderings still apply, since they only re-order the user's own content).
//
// Why a content check rather than "is this the owner?" or config.json autoCvVersions: there is no reliable owner
// marker (the name and contact are the user's own data), and autoCvVersions only decides whether `prepare` picks a
// cluster version, not whether that cluster's text is true for this CV. Checking the text against the master is what
// the CV rule ("only re-frame what is in cv/master.json") asks for, and it holds for any user and either setting.
//
// Two checks, both against the whole master CV text:
// - unsupportedClaims (also used by cv:feedback): every known skill (src/match.ts SKILLS) and number named.
// - PROFILE_FACTS below: the names and facts that check cannot see (employers, products, domains, degrees).
//
// This file is not part of masterHash (src/cv/versions.ts): it never changes the owner's versions, whose master has
// every fact, so editing it does not rebuild them.

/** Per profile: the employers, products and facts its title and summary name, beyond skills and numbers. */
export const PROFILE_FACTS: Record<keyof typeof PROFILES, string[]> = {
  laravel: ['Qureos', 'KYC', 'robo-advisory', 'fintech', 'marketplace', 'ticketing', 'auction'],
  tall: ['KYC', 'robo-advisory', 'fintech', 'marketplace', 'ticketing', 'auction'],
  'laravel-vue': ['KYC', 'fintech'],
  mern: ['Qureos', 'module owner', 'AI Screening', 'AI Interview', 'marketplace', 'ticketing', 'auction'],
  pern: ['Qureos', 'AI Screening', 'AI Interview'],
  'next-nest': ['Qureos', 'module owner', 'AI Screening', 'AI Interview'],
  'backend-node': ['Qureos'],
  'frontend-react': ['Qureos', 'AI Screening', 'AI Interview', 'marketplace', 'auction'],
  'ai-fullstack': [
    'Qureos',
    'module owner',
    'AI Screening',
    'AI Interview',
    'OpenAI GPT',
    'prompt engineering',
    'AI agents',
    'Artificial Intelligence',
  ],
};

/** What a cluster profile's title and summary name that `master` does not show (empty: the text fits this CV). */
export function profileMisfits(cluster: string, master: Cv): string[] {
  const p = PROFILES[cluster];
  if (!p) return [];
  const all = masterText(master).toLowerCase();
  const facts = (PROFILE_FACTS[cluster] ?? []).filter((f) => !all.includes(f.toLowerCase()));
  return [...unsupportedClaims(`${p.title}\n${p.summary}`, master), ...facts];
}

/**
 * The profile a version for `cluster` is built from: the cluster's profile as it is when its text fits `master`
 * (always the case for the owner's CV), else the same orderings with the master's own title and summary.
 * Undefined for a cluster without a profile.
 */
export function profileFor(cluster: string, master: Cv): Profile | undefined {
  const p = PROFILES[cluster];
  if (!p) return undefined;
  return profileMisfits(cluster, master).length ? { ...p, title: master.title, summary: master.summary } : p;
}
