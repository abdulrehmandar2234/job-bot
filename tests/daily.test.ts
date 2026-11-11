import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AI_FAILED,
  childEnv,
  claimDailyRun,
  cliRunner,
  configuredDailyTime,
  type DailyDeps,
  DEFAULT_DAILY_TIME,
  dailyDue,
  FETCH_FAILED,
  localDate,
  rotateLogs,
  runDaily,
  STEP_TIMEOUT_MIN,
  type StepResult,
} from '../src/commands/daily.ts';
import { scheduleSnippet } from '../src/commands/schedule.ts';
import type { Note } from '../src/notify.ts';

// `bot daily` (the scheduled morning run) with a fake CLI and notifier: no database, network or real notification.
const ROOT = join(import.meta.dirname, '..');
// The CLI makes config.json from config.default.json when it is missing; pointing it at the shipped file (only read
// here) keeps the repository free of one.
const CLI_ENV = { ...process.env, JOB_BOT_CONFIG: join(ROOT, 'config.default.json') };
const root = mkdtempSync(join(tmpdir(), 'talaash-daily-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** runDaily with fake steps: `results` maps a command name to its exit code and output. */
async function fakeDaily(results: Record<string, Partial<StepResult>> = {}, prune: () => number = () => 0, more: Partial<DailyDeps> = {}) {
  const calls: string[] = [];
  const notes: Note[] = [];
  const limits: Record<string, number> = {};
  let log = '';
  await runDaily({
    run: async (args, timeoutMs) => {
      calls.push(args.join(' '));
      limits[args[0]] = timeoutMs;
      const r = { code: 0, output: '', ...results[args[0]] };
      log += r.output;
      return r;
    },
    notify: async (n) => {
      calls.push('notify');
      notes.push(n);
    },
    log: (t) => {
      log += t;
    },
    prune: () => {
      calls.push('prune');
      return prune();
    },
    now: new Date(2026, 9, 30, 9, 5),
    ...more,
  });
  return { calls, notes, log, limits };
}

describe('runDaily', () => {
  it('runs fetch, check:open --limit 100, ai:score, then notifies, then backs up', async () => {
    const { calls, notes, log } = await fakeDaily({
      fetch: { output: 'old line\n10 postings checked, 1 new.\n' },
      'ai:score': { output: '3 jobs scored, 0 failed.\n' },
    });
    assert.deepEqual(calls, ['fetch', 'check:open --limit 100', 'ai:score', 'notify', 'backup', 'prune']);
    assert.deepEqual(notes, [
      { title: 'Talaash', message: '10 postings checked, 1 new. 3 jobs scored, 0 failed.', url: 'http://localhost:3100' },
    ]);
    assert.match(log, /^\n===== 2026-10-30 09:05 =====\n/);
    assert.match(log, /notification: 10 postings checked/);
    assert.doesNotMatch(log, /failed \(see above\)/);
  });

  it('a failing check:open is logged and still notifies (the old daily-fetch.sh test)', async () => {
    const { calls, notes, log } = await fakeDaily({ fetch: { output: '10 postings checked, 1 new.' }, 'check:open': { code: 1 } });
    assert.deepEqual(calls, ['fetch', 'check:open --limit 100', 'ai:score', 'notify', 'backup', 'prune']);
    assert.match(notes[0].message, /^10 postings checked/);
    assert.match(log, /check:open failed \(see above\)/);
  });

  it('a failed AI review is reported in the notification instead of a score count', async () => {
    const { notes } = await fakeDaily({ fetch: { output: '5 postings checked' }, 'ai:score': { code: 1, output: '7 jobs scored' } });
    assert.equal(notes[0].message, `5 postings checked ${AI_FAILED}`);
  });

  it('a failed fetch skips check:open and ai:score, says so, and still backs up', async () => {
    const { calls, notes } = await fakeDaily({ fetch: { code: 1, output: 'ECONNREFUSED' } });
    assert.deepEqual(calls, ['fetch', 'notify', 'backup', 'prune']);
    assert.equal(notes[0].message, FETCH_FAILED);
  });

  it('a fetch where every source failed blames the network, not PostgreSQL, and names the first error', async () => {
    const output =
      '✗ One: fetch failed\n✗ Two: fetch failed\n\n0 postings checked, 0 new. 4 matching jobs waiting (status=new).\n' +
      '✗ All 2 sources failed — is the network up? First error: One: fetch failed\n';
    const { calls, notes } = await fakeDaily({ fetch: { code: 1, output } });
    assert.deepEqual(calls, ['fetch', 'notify', 'backup', 'prune']);
    assert.equal(notes[0].message, 'Fetch failed: 2 of 2 sources failed — is the network up? First error: One: fetch failed');
    assert.doesNotMatch(notes[0].message, /PostgreSQL/);
  });

  it('the database being down keeps the PostgreSQL message; any other failure shows its last line', async () => {
    const down = await fakeDaily({ fetch: { code: 1, output: 'Error: connect ECONNREFUSED 127.0.0.1:5432\n' } });
    assert.equal(down.notes[0].message, FETCH_FAILED);
    const other = await fakeDaily({ fetch: { code: 1, output: 'config.json: stacks: unknown stack preset "pyhton"\n' } });
    assert.equal(other.notes[0].message, 'Fetch failed: config.json: stacks: unknown stack preset "pyhton" See data/fetch.log');
  });

  it('a fetch where some sources failed says how many in the notification', async () => {
    const { notes } = await fakeDaily({
      fetch: {
        output: '10 postings checked, 1 new. 2 matching jobs waiting (status=new).\n! 3 of 20 sources failed (first error: X: 500)\n',
      },
      'ai:score': { output: '1 jobs scored, 0 failed.\n' },
    });
    assert.equal(
      notes[0].message,
      '10 postings checked, 1 new. 2 matching jobs waiting (status=new). 3 of 20 sources failed. 1 jobs scored, 0 failed.',
    );
  });

  it('gives every step its time limit', async () => {
    const { limits } = await fakeDaily({}, () => 0, { indStale: () => true });
    assert.deepEqual(limits, {
      'sponsors:update': STEP_TIMEOUT_MIN['sponsors:update'] * 60_000,
      fetch: 30 * 60_000,
      'check:open': 15 * 60_000,
      'ai:score': 60 * 60_000,
      backup: 10 * 60_000,
    });
  });

  it('a step that times out is logged, the later steps still run, and the notification names it', async () => {
    const { calls, notes, log } = await fakeDaily({
      fetch: { output: '10 postings checked, 1 new.' },
      'ai:score': { code: 124, timedOut: true, output: 'scoring...' },
    });
    assert.deepEqual(calls, ['fetch', 'check:open --limit 100', 'ai:score', 'notify', 'backup', 'prune']);
    assert.match(log, /\nai:score timed out after 60 min\n/);
    assert.equal(notes[0].message, '10 postings checked, 1 new. Timed out: ai:score (see data/fetch.log).');
  });

  it('a fetch that times out says so instead of blaming PostgreSQL, and the backup still runs', async () => {
    const { calls, notes, log } = await fakeDaily({ fetch: { code: 124, timedOut: true } });
    assert.deepEqual(calls, ['fetch', 'notify', 'backup', 'prune']);
    assert.equal(notes[0].message, 'Fetch timed out after 30 min. See data/fetch.log');
    assert.match(log, /fetch timed out after 30 min/);
  });

  it('refreshes the IND register first when it is stale, and not when it is fresh', async () => {
    const stale = await fakeDaily({}, () => 0, { indStale: () => true });
    assert.deepEqual(stale.calls, ['sponsors:update', 'fetch', 'check:open --limit 100', 'ai:score', 'notify', 'backup', 'prune']);
    const fresh = await fakeDaily({}, () => 0, { indStale: () => false });
    assert.equal(fresh.calls[0], 'fetch');
  });

  it('a failed IND refresh only shows in the log; the fetch still runs', async () => {
    const { calls, notes, log } = await fakeDaily(
      { 'sponsors:update': { code: 1, output: 'IND register looks wrong' }, fetch: { output: '5 postings checked' } },
      () => 0,
      { indStale: () => true },
    );
    assert.equal(calls[1], 'fetch');
    assert.match(log, /sponsors:update failed \(see above\); the IND register stays as it was/);
    assert.match(notes[0].message, /^5 postings checked/);
  });

  it('rotates logs before writing and logs which ones', async () => {
    const order: string[] = [];
    let log = '';
    await runDaily({
      run: async () => ({ code: 0, output: '' }),
      notify: async () => {},
      log: (t) => {
        order.push('log');
        log += t;
      },
      prune: () => 0,
      rotate: () => {
        order.push('rotate');
        return ['rotated data/fetch.log to data/fetch.log.1'];
      },
    });
    assert.deepEqual(order.slice(0, 2), ['rotate', 'log']);
    assert.match(log, /=====\nrotated data\/fetch\.log to data\/fetch\.log\.1\n/);
  });

  it('a failed backup only shows in the log', async () => {
    const { calls, log } = await fakeDaily({ backup: { code: 1 } });
    assert.deepEqual(calls.slice(-2), ['backup', 'prune']);
    assert.match(log, /backup failed \(see above\)\n/);
  });

  it('prunes the http cache last and logs how many entries went', async () => {
    const { calls, log } = await fakeDaily({}, () => 3);
    assert.equal(calls.at(-1), 'prune');
    assert.match(log, /http-cache: removed 3 entries older than 30 days\n$/);
  });

  it('runs the cleanup after the backup and before the prune, logging what it removed', async () => {
    const { calls, log } = await fakeDaily({}, () => 0, {
      cleanup: async () => {
        return ['cleanup: removed 2 old question files: a.txt, b.txt'];
      },
    });
    assert.deepEqual(calls.slice(-2), ['backup', 'prune']);
    assert.match(log, /notification: .*\n(.|\n)*cleanup: removed 2 old question files: a\.txt, b\.txt\nhttp-cache: removed/);
  });

  it('a failing or hung cleanup only shows in the log, and the prune still runs', async () => {
    const failing = await fakeDaily({}, () => 0, {
      cleanup: async () => {
        throw new Error('no database');
      },
    });
    assert.match(failing.log, /cleanup failed: no database\n/);
    assert.equal(failing.calls.at(-1), 'prune');
    const started = Date.now();
    const hung = await fakeDaily({}, () => 0, { cleanup: () => new Promise(() => {}), timeouts: { cleanup: 50 } });
    assert.match(hung.log, /cleanup timed out after 0\.1 s\n/);
    assert.equal(hung.calls.at(-1), 'prune');
    assert.ok(Date.now() - started < 5000);
  });

  it('a failing prune only shows in the log', async () => {
    const { notes, log } = await fakeDaily({}, () => {
      throw new Error('disk gone');
    });
    assert.match(log, /http-cache prune failed: disk gone\n$/);
    assert.equal(notes.length, 1); // the notification already went out
  });
});

describe('rotateLogs', () => {
  it('renames logs over the limit to .1, replacing an older .1, and leaves small or missing ones alone', () => {
    const dir = mkdtempSync(join(root, 'logs-'));
    const big = join(dir, 'fetch.log');
    const small = join(dir, 'tasks.log');
    writeFileSync(big, 'x'.repeat(20));
    writeFileSync(`${big}.1`, 'older');
    writeFileSync(small, 'y'.repeat(5));
    const lines = rotateLogs([big, small, join(dir, 'missing.log')], 10);
    assert.deepEqual(lines, [`rotated ${big} to ${big}.1`]);
    assert.equal(existsSync(big), false);
    assert.equal(readFileSync(`${big}.1`, 'utf8'), 'x'.repeat(20));
    assert.equal(readFileSync(small, 'utf8'), 'yyyyy');
    assert.equal(existsSync(`${small}.1`), false);
  });
});

describe('cliRunner', () => {
  // A stand-in for src/cli.ts: prints its arguments and folder, writes to stderr, and exits with the code it is given.
  const fakeCli = join(root, 'fake-cli.mjs');
  writeFileSync(
    fakeCli,
    `console.log('args ' + process.argv.slice(2).join(' ')); console.log('cwd ' + process.cwd()); console.error('to stderr');
process.exitCode = Number(process.argv[3] ?? 0);`,
  );

  it('runs node <cli> <args> in the repository and appends stdout and stderr to the log', async () => {
    const log = join(root, 'fetch.log');
    writeFileSync(log, 'before\n');
    const r = await cliRunner(log, fakeCli)(['fetch', '0']);
    assert.equal(r.code, 0);
    assert.match(r.output, /^args fetch 0$/m);
    assert.match(r.output, /^to stderr$/m);
    assert.ok(r.output.includes(`cwd ${ROOT}`), r.output);
    assert.equal(readFileSync(log, 'utf8'), `before\n${r.output}`);
  });

  it('returns the exit code of a failing command', async () => {
    const r = await cliRunner(join(root, 'fetch2.log'), fakeCli)(['ai:score', '3']);
    assert.equal(r.code, 3);
  });

  // A step that never ends: `hang` waits forever, `stubborn` also ignores SIGTERM (so only SIGKILL stops it).
  const hangCli = join(root, 'hang-cli.mjs');
  writeFileSync(
    hangCli,
    `const [step, mode] = process.argv.slice(2);
console.log('started ' + step);
if (mode === 'stubborn') process.on('SIGTERM', () => console.log('ignoring SIGTERM'));
if (mode === 'hang' || mode === 'stubborn') setInterval(() => {}, 1000);
else console.log('done ' + step);`,
  );

  it('stops a step that runs past its time limit and reports it as timed out', async () => {
    const log = join(root, 'hang.log');
    const started = Date.now();
    const r = await cliRunner(log, hangCli, process.env, 200)(['fetch', 'hang'], 300);
    assert.equal(r.timedOut, true);
    assert.equal(r.code, 124);
    assert.match(readFileSync(log, 'utf8'), /started fetch/);
    assert.ok(Date.now() - started < 5000, 'stopped promptly');
  });

  it('kills a step that ignores SIGTERM after the grace period', { skip: process.platform === 'win32' }, async () => {
    const r = await cliRunner(join(root, 'stubborn.log'), hangCli, process.env, 200)(['ai:score', 'stubborn'], 1000);
    assert.equal(r.timedOut, true);
    assert.match(r.output, /ignoring SIGTERM/);
  });

  it('a step that ends in time is not marked timed out', async () => {
    const r = await cliRunner(join(root, 'quick.log'), hangCli, process.env, 200)(['backup', 'quick'], 10_000);
    assert.equal(r.code, 0);
    assert.equal(r.timedOut, undefined);
  });

  it('runDaily with a hung ai:score: it is killed, the backup still runs and the notification names it', async () => {
    const log = join(root, 'daily-hang.log');
    const run = cliRunner(log, hangCli, process.env, 200);
    const notes: Note[] = [];
    await runDaily({
      // Only ai:score hangs; every other step ends at once.
      run: (args, ms) => run([args[0], args[0] === 'ai:score' ? 'hang' : 'quick'], ms),
      notify: async (n) => {
        notes.push(n);
      },
      log: (t) => appendFileSync(log, t),
      prune: () => 0,
      timeouts: { 'ai:score': 300 },
    });
    const text = readFileSync(log, 'utf8');
    assert.match(text, /ai:score timed out after 0\.3 s/);
    assert.match(text, /done backup/);
    assert.match(notes[0].message, /Timed out: ai:score/);
  });
});

describe('childEnv', () => {
  it('puts ~/.local/bin (the Claude CLI) first on PATH, once', () => {
    assert.equal(childEnv({ PATH: '/usr/bin:/bin' }, '/home/a', 'linux').PATH, '/home/a/.local/bin:/usr/bin:/bin');
    assert.equal(childEnv({ PATH: '/home/a/.local/bin:/bin' }, '/home/a', 'linux').PATH, '/home/a/.local/bin:/bin');
    assert.equal(childEnv({}, '/home/a', 'darwin').PATH, '/home/a/.local/bin');
  });

  it('on Windows uses the Path variable as it is spelled, and ; between folders', () => {
    const env = childEnv({ Path: 'C:\\Windows', X: '1' }, 'C:\\Users\\a', 'win32');
    assert.deepEqual(env, { Path: 'C:\\Users\\a\\.local\\bin;C:\\Windows', X: '1' });
  });
});

// The launchd entry point (the owner's plist runs `/bin/zsh scripts/daily-fetch.sh`): it must hand over to `bot daily`.
describe('scripts/daily-fetch.sh', { skip: !existsSync('/bin/zsh') }, () => {
  it('runs `node ... src/cli.ts daily` in the repository, with ~/.local/bin on PATH, passing its arguments on', () => {
    const home = join(root, 'home');
    const bin = join(home, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(root, 'repo', 'scripts'), { recursive: true });
    copyFileSync(join(ROOT, 'scripts', 'daily-fetch.sh'), join(root, 'repo', 'scripts', 'daily-fetch.sh'));
    const calls = join(root, 'calls.txt');
    writeFileSync(join(bin, 'node'), `#!/bin/sh\necho "$(pwd) node $*" >> "${calls}"\n`);
    chmodSync(join(bin, 'node'), 0o755);
    const r = spawnSync('/bin/zsh', [join(root, 'repo', 'scripts', 'daily-fetch.sh')], {
      cwd: root,
      encoding: 'utf8',
      env: { HOME: home },
    });
    assert.equal(r.status, 0, r.stderr);
    const [line] = readFileSync(calls, 'utf8').trim().split('\n');
    assert.match(line, /\/repo node --no-warnings --env-file-if-exists=\.env src\/cli\.ts daily$/);
    const due = spawnSync('/bin/zsh', [join(root, 'repo', 'scripts', 'daily-fetch.sh'), '--if-due'], { cwd: root, env: { HOME: home } });
    assert.equal(due.status, 0);
    assert.match(readFileSync(calls, 'utf8').trim().split('\n')[1], /src\/cli\.ts daily --if-due$/);
  });
});

describe('daily --if-due', () => {
  const at = (h: number, m: number, day = 11) => new Date(2026, 10, day, h, m);

  it('is due at dailyTime or later, once a local day', () => {
    assert.equal(dailyDue('09:00', at(8, 59), null), false);
    assert.equal(dailyDue('09:00', at(9, 0), null), true);
    assert.equal(dailyDue('09:00', at(23, 30), '2026-11-10'), true, 'missed while asleep: runs when it wakes');
    assert.equal(dailyDue('09:00', at(9, 30), '2026-11-11'), false, 'already ran today');
    assert.equal(dailyDue('18:30', at(18, 29), null), false);
    assert.equal(dailyDue('18:30', at(18, 30), null), true);
    assert.equal(dailyDue('18:30', at(19, 0), null), true);
    assert.equal(dailyDue('00:00', at(0, 0, 12), '2026-11-11'), true);
  });

  it('claims the day in the marker file before the run, so a later check does not start it again', () => {
    const marker = join(root, 'daily-last-run');
    rmSync(marker, { force: true });
    assert.equal(claimDailyRun(marker, '07:30', at(7, 0)), false);
    assert.equal(existsSync(marker), false, 'nothing written before the time');
    assert.equal(claimDailyRun(marker, '07:30', at(7, 30)), true);
    assert.equal(readFileSync(marker, 'utf8'), '2026-11-11\n');
    assert.equal(claimDailyRun(marker, '07:30', at(8, 0)), false);
    assert.equal(claimDailyRun(marker, '07:30', at(7, 45, 12)), true, 'the next day');
    assert.equal(localDate(at(0, 5, 1)), '2026-11-01');
  });

  it('reads dailyTime from config.json, 09:00 when it is missing, invalid or config.json cannot be read', () => {
    assert.equal(
      configuredDailyTime(() => '18:30'),
      '18:30',
    );
    assert.equal(
      configuredDailyTime(() => undefined),
      DEFAULT_DAILY_TIME,
    );
    assert.equal(
      configuredDailyTime(() => '25:00'),
      '09:00',
    );
    assert.equal(
      configuredDailyTime(() => {
        throw new Error('Invalid settings file');
      }),
      '09:00',
    );
  });

  it('before setup (no master CV yet) waits without claiming the day, so the first run after setup is today', () => {
    // As right after `docker compose up`: the scheduler's first check is past dailyTime, but there is no CV to score with.
    const data = join(root, 'data-no-cv');
    const r = spawnSync(process.execPath, ['--no-warnings', 'src/cli.ts', 'daily', '--if-due'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...CLI_ENV, JOB_BOT_DATA_DIR: data, JOB_BOT_MASTER: join(root, 'no-such-master.json') },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout + r.stderr, '');
    assert.equal(existsSync(join(data, 'daily-last-run')), false, 'the day is not claimed');
    assert.equal(existsSync(join(data, 'fetch.log')), false, 'nothing ran');
  });

  it('exits quietly when today is claimed already: no output, no run', () => {
    // Only this case is safe to run for real at any hour; when the run is due is covered by dailyDue above.
    const data = join(root, 'data-claimed');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'daily-last-run'), `${localDate(new Date())}\n`);
    const r = spawnSync(process.execPath, ['--no-warnings', 'src/cli.ts', 'daily', '--if-due'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...CLI_ENV, JOB_BOT_DATA_DIR: data },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout + r.stderr, '');
    assert.equal(existsSync(join(data, 'fetch.log')), false);
  });
});

describe('scheduleSnippet', () => {
  it('says when the run happens: every 30 minutes a check, the run once a day at dailyTime', () => {
    const s = scheduleSnippet({ platform: 'darwin', root: '/r', node: '/n', user: 'me', time: '18:30' });
    assert.match(s, /^# Talaash's daily run: the scheduler starts `bot daily --if-due` every 30 minutes/);
    assert.match(s, /Changing the time later needs no change here/);
    assert.match(s, /once\n# a day at 18:30 \(config\.json "dailyTime", or the Settings page\)/);
    assert.match(scheduleSnippet({ platform: 'linux', root: '/r', node: '/n', user: 'me' }), /a day at 09:00 /);
  });

  it('macOS: a launchd plist that runs scripts/daily-fetch.sh --if-due with zsh every 30 minutes and at login', () => {
    const s = scheduleSnippet({ platform: 'darwin', root: '/Users/me/job bot', node: '/opt/homebrew/bin/node', user: 'me' });
    assert.match(s, /<string>com\.me\.job-bot\.fetch<\/string>/);
    assert.match(
      s,
      /<string>\/bin\/zsh<\/string><string>\/Users\/me\/job bot\/scripts\/daily-fetch\.sh<\/string><string>--if-due<\/string>/,
    );
    assert.match(s, /<key>StartInterval<\/key><integer>1800<\/integer>\n {2}<key>RunAtLoad<\/key><true\/>/);
    assert.doesNotMatch(s, /StartCalendarInterval|Hour/);
    assert.match(s, /launchctl bootstrap gui\/\$\(id -u\) ~\/Library\/LaunchAgents\/com\.me\.job-bot\.fetch\.plist/);
  });

  it('Linux: a systemd user service and persistent timer, and a cron line with the session bus', () => {
    const s = scheduleSnippet({ platform: 'linux', root: "/home/me/o'k", node: '/usr/bin/node', user: 'me', uid: 1000 });
    assert.match(s, /^WorkingDirectory=\/home\/me\/o'k$/m);
    assert.match(s, /^ExecStart="\/usr\/bin\/node" --no-warnings --env-file-if-exists=\.env src\/cli\.ts daily --if-due$/m);
    assert.match(s, /^OnCalendar=\*:0\/30\nPersistent=true$/m);
    assert.match(s, /systemctl --user enable --now job-bot-fetch\.timer/);
    assert.match(s, /^DBUS_SESSION_BUS_ADDRESS=unix:path=\/run\/user\/1000\/bus$/m);
    assert.match(s, /^\*\/30 \* \* \* \* cd '\/home\/me\/o'\\''k' && '\/usr\/bin\/node' --no-warnings .* daily --if-due$/m);
  });

  it('Windows: a once-a-day task at dailyTime (no console window every 30 minutes), in PowerShell and schtasks', () => {
    const s = scheduleSnippet({
      platform: 'win32',
      root: "C:\\Users\\O'Neil\\talaash",
      node: 'C:\\Program Files\\nodejs\\node.exe',
      user: 'x',
      time: '18:30',
    });
    assert.match(s, /^# Talaash's daily run: Task Scheduler starts `bot daily` once a day at 18:30/);
    assert.match(s, /run\n# `npm run bot -- schedule:print` again/);
    assert.match(
      s,
      /-Execute 'C:\\Program Files\\nodejs\\node\.exe' -Argument '--no-warnings --env-file-if-exists=\.env src\/cli\.ts daily'/,
    );
    assert.match(s, /-WorkingDirectory 'C:\\Users\\O''Neil\\talaash'/);
    assert.match(s, /New-ScheduledTaskTrigger -Daily -At '18:30'/);
    assert.match(s, /-StartWhenAvailable -MultipleInstances IgnoreNew/);
    assert.doesNotMatch(s, /--if-due|Repetition/);
    assert.ok(
      s.includes(
        'schtasks /Create /F /SC DAILY /ST 18:30 /TN "job-bot daily fetch" /TR "\\"C:\\Program Files\\nodejs\\node.exe\\" --no-warnings \\"C:\\Users\\O\'Neil\\talaash\\src\\cli.ts\\" daily"',
      ),
      s,
    );
  });
});

describe('bot schedule:print', () => {
  it('prints the snippet for the asked OS, and refuses an unknown one', () => {
    const out = spawnSync(process.execPath, ['--no-warnings', 'src/cli.ts', 'schedule:print', '--os', 'linux'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: CLI_ENV,
    });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /systemd user timer/);
    assert.ok(out.stdout.includes(process.execPath));
    const bad = spawnSync(process.execPath, ['--no-warnings', 'src/cli.ts', 'schedule:print', '--os', 'beos'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: CLI_ENV,
    });
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /Usage: schedule:print/);
  });
});
