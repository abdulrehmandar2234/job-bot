import { ensureConfigFile, InvalidSettingsError } from './settings.ts';
import type { Command, Flags } from './commands/shared.ts';

const [cmd, ...rest] = process.argv.slice(2);
const flags: Flags = {};
const args: string[] = [];
for (let i = 0; i < rest.length; i++) {
  const eq = rest[i].indexOf('=');
  // --name=value keeps any value, even one starting with "--" (task:run passes --feedback=<text> this way).
  if (rest[i].startsWith('--') && eq > 2) flags[rest[i].slice(2, eq)] = rest[i].slice(eq + 1);
  else if (rest[i].startsWith('--'))
    flags[rest[i].slice(2)] = rest[i + 1]?.startsWith('--') || rest[i + 1] === undefined ? 'true' : rest[++i];
  else args.push(rest[i]);
}

// Each command lives in src/commands/ and is loaded only when it runs, so a command never pays for (or breaks on)
// another one's imports. Loading one validates config.json when it needs it (see settings.ts).
const commands: Record<string, () => Promise<Command>> = {
  'sponsors:update': async () => (await import('./commands/sponsors.ts')).sponsorsUpdate,
  fetch: async () => (await import('./commands/fetch.ts')).fetch,
  dedupe: async () => () => {}, // grouping itself runs after the command, see below
  migrate: async () => () => {}, // migrations run before every DB command, see below; this one only reports them
  rescore: async () => (await import('./commands/fetch.ts')).rescore,
  discover: async () => (await import('./commands/discover.ts')).discover,
  add: async () => (await import('./commands/add.ts')).add,
  list: async () => (await import('./commands/list.ts')).list,
  show: async () => (await import('./commands/list.ts')).show,
  stats: async () => (await import('./commands/list.ts')).stats,
  prepare: async () => (await import('./commands/prepare.ts')).prepare,
  letter: async () => (await import('./commands/prepare.ts')).letter,
  summary: async () => (await import('./commands/prepare.ts')).summary,
  'cv:tailor': async () => (await import('./commands/cv.ts')).cvTailor,
  'cv:template': async () => (await import('./commands/cv.ts')).cvTemplate,
  'cv:templates': async () => (await import('./commands/cv-templates.ts')).cvTemplates,
  'cv:preview': async () => (await import('./commands/cv-templates.ts')).cvPreview,
  'cv:feedback': async () => (await import('./commands/cv.ts')).cvFeedback,
  'cv:review': async () => (await import('./commands/cv.ts')).cvReview,
  'letter:pdf': async () => (await import('./commands/prepare.ts')).letterPdf,
  'check:open': async () => (await import('./commands/open.ts')).checkOpen,
  'ai:score': async () => (await import('./commands/ai.ts')).aiScore,
  answer: async () => (await import('./commands/ai.ts')).answer,
  prep: async () => (await import('./commands/prep.ts')).prep,
  'follow-ups': async () => (await import('./commands/followup.ts')).followUps,
  'follow-up': async () => (await import('./commands/followup.ts')).followUp,
  'followed-up': async () => (await import('./commands/followup.ts')).followedUp,
  custom: async () => (await import('./commands/cv.ts')).custom,
  mark: async () => (await import('./commands/mark.ts')).mark,
  contacts: async () => (await import('./commands/contacts.ts')).contacts,
  'contact:add': async () => (await import('./commands/contacts.ts')).contactAdd,
  'cv:default': async () => (await import('./commands/cv.ts')).cvDefault,
  'cv:build': async () => (await import('./commands/cv.ts')).cvBuild,
  versions: async () => (await import('./commands/cv.ts')).versions,
  ats: async () => (await import('./commands/ats.ts')).ats,
  'settings:check': async () => (await import('./commands/settings.ts')).settingsCheck,
  'settings:save': async () => (await import('./commands/settings.ts')).settingsSave,
  'task:run': async () => (await import('./commands/task.ts')).taskRun,
  setup: async () => (await import('./commands/setup.ts')).setup,
  backup: async () => (await import('./commands/backup.ts')).backup,
  daily: async () => (await import('./commands/daily.ts')).daily,
  'schedule:print': async () => (await import('./commands/schedule.ts')).schedulePrint,
};
// Commands that only touch files: no database connection or migrations.
const NO_DB = ['settings:check', 'settings:save', 'setup', 'backup', 'daily', 'schedule:print', 'cv:templates', 'cv:preview'];

// A fresh clone has config.default.json only: every command (setup and settings:check too) starts from a copy.
ensureConfigFile();

const load = commands[cmd ?? ''];
if (!load) {
  console.log(`Commands:
  setup                           first run: questions for your profile and target countries (cv/applicant.json, config.json)
  sponsors:update                 download Dutch IND recognised-sponsor register
  fetch [--company name]          pull jobs from company boards, filter + score
  rescore                         re-apply filters/scoring to stored jobs (after config changes)
  discover <slug...> [--add]      find a company's job board (6 ATS, or a myworkdayjobs URL); --add saves hits
  list [--status new] [--country AE|SA|NL] [--min 60] [--limit 30]
  show <id> [--full]              details (+ full description)
  prepare <id> [--cv cluster]     default CV (or --cv version); checks the posting is still open first (--force
                                  skips that); --letter also writes the cover letter
  letter <id> [--template]        write or rewrite the cover letter (AI from the description, else the template)
         [--feedback "shorter"]   AI rewrites the current letter with your feedback (prints a note if it left
                                  something out because the CV does not support it)
  summary <id> [--feedback "…"]   AI writes a CV summary for this job (or rewrites it with your feedback)
  cv:tailor <id>                  one-off CV version with the job's CV summary (sets it as the job's CV)
  cv:templates                    list the CV designs (default: config.json cvTemplate, else classic)
  cv:template <id> <template>     use a CV design for this job and re-render its CV as a new version
  cv:preview <template> [--pdf]   the master CV in a design (HTML, or data/previews/<template>.pdf)
  cv:feedback <id> --feedback "…" AI revises the job's CV with your feedback (master CV content only, a new version)
  cv:review <id>                  AI suggests how to improve the job's CV for this job (stored on the job)
  letter:pdf <id>                 print the cover letter to cover-letter.pdf in the job's applications/ folder
  check:open [<id>...] [--status new,prepared] [--limit N]
                                  mark closed postings expired (default: new + prepared not checked for 3 days)
  ai:score [--id x] [--limit n]   AI fit review of matching jobs (--all to redo; --location-filtered re-checks
                                  jobs an earlier review filtered for location, and brings back those that pass)
  answer <id> [--file q.txt]      AI drafts answers to pasted form questions (--clear to reset)
  prep <id>                       AI interview prep: likely questions, STAR stories, company brief, gaps
  follow-ups                      applied jobs with no news for 7+ days that are due a follow-up
  follow-up <id> [--template]     draft a short follow-up message (you send it yourself)
  followed-up <id>                record that you sent a follow-up (reminds again after 7 days, at most 2)
  custom <id> --overrides f.json  one-off CV for a single job
  add [--file job.json]           add job found in browser (JSON or stdin)
  mark <id> <status> [note]       applied | interview | offer | rejected | skipped | expired
                                  (skipped: --reason stack|seniority|salary|location|company|language|other)
  contacts <id>                   contacts for a job, plus people you know at the same company
  contact:add <id> --name "Jane Doe" [--role recruiter|"hiring manager"|referral|other] [--email x]
                                  [--linkedin https://linkedin.com/in/x] [--phone x] [--notes x] [--referral "to ask"]
  cv:default                      rebuild default CV PDF from cv/master.json
  cv:build [cluster...]           pre-build CV versions
  versions                        list CV versions and usage
  ats <id> [--cv cluster]         CV keyword check: shown, hidden-but-true and missing job keywords (--json)
  stats
  migrate                         apply pending database migrations and list them (every DB command does this
                                  first; the dashboard runs it once when it starts)
  settings:check --kind config|applicant [--file x.json]   validate settings (JSON result)
  settings:save --kind config|applicant [--file x.json]    validate, then save if valid
  task:run <id>                   run a queued background task (the dashboard starts these)
  daily                           the scheduled morning run: fetch, check:open, ai:score, a notification, backup
                                  (output in data/fetch.log)
  schedule:print [--os macos|linux|windows]
                                  print the scheduler setup (launchd, systemd/cron, Task Scheduler) for this clone
  backup                          pg_dump of the database into data/backups/<db>-YYYY-MM-DD.sql.gz (keeps 14)`);
} else {
  try {
    const run = await load();
    if (NO_DB.includes(cmd)) await run(args, flags);
    else {
      const { dedupe, migrate, pool } = await import('./db.ts');
      const applied = await migrate();
      if (cmd === 'migrate')
        console.log(applied.length ? `Applied ${applied.length} migration(s): ${applied.join(', ')}` : 'Database is up to date.');
      try {
        await run(args, flags);
        // Any command that adds jobs or changes their status can change which copy of a job is the primary.
        if (['fetch', 'add', 'rescore', 'mark', 'prepare', 'check:open', 'dedupe'].includes(cmd)) {
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
