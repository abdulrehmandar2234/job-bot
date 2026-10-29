import { InvalidSettingsError } from './settings.ts';
import type { Command, Flags } from './commands/shared.ts';

const [cmd, ...rest] = process.argv.slice(2);
const flags: Flags = {};
const args: string[] = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[i + 1]?.startsWith('--') || rest[i + 1] === undefined ? 'true' : rest[++i];
  else args.push(rest[i]);
}

// Each command lives in src/commands/ and is loaded only when it runs, so a command never pays for (or breaks on)
// another one's imports. Loading one validates config.json when it needs it (see settings.ts).
const commands: Record<string, () => Promise<Command>> = {
  'sponsors:update': async () => (await import('./commands/sponsors.ts')).sponsorsUpdate,
  fetch: async () => (await import('./commands/fetch.ts')).fetch,
  dedupe: async () => () => {}, // grouping itself runs after the command, see below
  rescore: async () => (await import('./commands/fetch.ts')).rescore,
  discover: async () => (await import('./commands/discover.ts')).discover,
  add: async () => (await import('./commands/add.ts')).add,
  list: async () => (await import('./commands/list.ts')).list,
  show: async () => (await import('./commands/list.ts')).show,
  stats: async () => (await import('./commands/list.ts')).stats,
  prepare: async () => (await import('./commands/prepare.ts')).prepare,
  'ai:score': async () => (await import('./commands/ai.ts')).aiScore,
  answer: async () => (await import('./commands/ai.ts')).answer,
  custom: async () => (await import('./commands/cv.ts')).custom,
  mark: async () => (await import('./commands/mark.ts')).mark,
  'cv:default': async () => (await import('./commands/cv.ts')).cvDefault,
  'cv:build': async () => (await import('./commands/cv.ts')).cvBuild,
  versions: async () => (await import('./commands/cv.ts')).versions,
  'settings:check': async () => (await import('./commands/settings.ts')).settingsCheck,
  'settings:save': async () => (await import('./commands/settings.ts')).settingsSave,
};
// Commands that only touch files: no database connection or migrations.
const NO_DB = ['settings:check', 'settings:save'];

const load = commands[cmd ?? ''];
if (!load) {
  console.log(`Commands:
  sponsors:update                 download Dutch IND recognised-sponsor register
  fetch [--company name]          pull jobs from company boards, filter + score
  rescore                         re-apply filters/scoring to stored jobs (after config changes)
  discover <slug...> [--add]      find a company's job board (6 ATS); --add saves hits to config.json
  list [--status new] [--country AE|SA|NL] [--min 60] [--limit 30]
  show <id> [--full]              details (+ full description)
  prepare <id> [--cv cluster]     default CV (or --cv version) + AI cover letter (--template for the plain one)
  ai:score [--id x] [--limit n]   AI fit review of matching jobs via local Claude CLI (--all to redo)
  answer <id> [--file q.txt]      AI drafts answers to pasted form questions (--clear to reset)
  custom <id> --overrides f.json  one-off CV for a single job
  add [--file job.json]           add job found in browser (JSON or stdin)
  mark <id> <status> [note]       applied | interview | offer | rejected | skipped
  cv:default                      rebuild default CV PDF from cv/master.json
  cv:build [cluster...]           pre-build CV versions
  versions                        list CV versions and usage
  stats
  settings:check --kind config|applicant [--file x.json]   validate settings (JSON result)
  settings:save --kind config|applicant [--file x.json]    validate, then save if valid`);
} else {
  try {
    const run = await load();
    if (NO_DB.includes(cmd)) await run(args, flags);
    else {
      const { dedupe, migrate, pool } = await import('./db.ts');
      await migrate();
      try {
        await run(args, flags);
        // Any command that adds jobs or changes their status can change which copy of a job is the primary.
        if (['fetch', 'add', 'rescore', 'mark', 'prepare', 'dedupe'].includes(cmd)) {
          const n = await dedupe();
          if (n) console.log(`${n} duplicate postings grouped under their primary job.`);
        }
      } finally {
        await pool.end();
      }
    }
  } catch (e) {
    if (!(e instanceof InvalidSettingsError)) throw e;
    console.error(e.message);
    process.exitCode = 1;
  }
}
