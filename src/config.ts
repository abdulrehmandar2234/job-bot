import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const path = (...p: string[]) => join(ROOT, ...p);

export type Country = { name: string; visa: 'employer' | 'ind-register'; match: string };
// 'workday' (added for ROADMAP feature 4): token is "<tenant>/<wdN>/<site>", e.g. "acme/wd3/AcmeCareers".
export const ATS = ['greenhouse', 'lever', 'ashby', 'recruitee', 'workable', 'smartrecruiters', 'workday'] as const;
export type Company = { name: string; ats: (typeof ATS)[number]; token: string; indName?: string };
export type Config = {
  cvFileName: string;
  autoCvVersions: boolean; // false = always send the default CV unless `prepare --cv <cluster>` is given
  chromePath: string;
  minScore: number;
  maxAgeDays: number; // postings older than this are filtered out
  countries: Record<string, Country>;
  companies: Company[];
  roleInclude: string;
  roleExclude: string;
  ai: {
    enabled: boolean;
    claudePath: string;          // local Claude Code CLI (uses its signed-in account, no API key)
    scoreModel: string;          // fast model for match scoring
    letterModel: string;         // better writer for cover letters
    maxScorePerRun: number;      // cap per `ai:score` run
    concurrency: number;
  };
  linkedin: {
    enabled: boolean;
    keywords: string[];
    locations: string[];         // onsite searches, as typed in LinkedIn's location box
    remoteFrom: string;          // remote (f_WT=2) search located here, e.g. "Pakistan"
    pagesPerSearch: number;      // 10 results per page
  };
  remote: {
    enabled: boolean;
    boards: string[];            // himalayas | remotive | remoteok | arbeitnow | adzuna
    himalayasQueries: string[];
    allow: string;               // remote regions that include the candidate's country
    deny: string;                // remote regions / phrases that exclude it
    flag: string;                // allowed, but worth double-checking
  };
  // New for ROADMAP feature 4 (sources); optional, so older config.json files still load.
  adzuna?: {
    countries: string[];         // Adzuna country codes; Adzuna has no 'ae' or 'sa' index
    keywords?: string[];         // defaults to linkedin.keywords
    pagesPerSearch: number;      // 50 results per page
  };
};

export const config: Config = JSON.parse(readFileSync(path('config.json'), 'utf8'));
