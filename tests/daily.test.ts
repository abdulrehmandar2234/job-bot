import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AI_FAILED, childEnv, cliRunner, FETCH_FAILED, runDaily, type StepResult } from '../src/commands/daily.ts';
import { scheduleSnippet } from '../src/commands/schedule.ts';
import type { Note } from '../src/notify.ts';

// `bot daily` (the scheduled morning run) with a fake CLI and notifier: no database, network or real notification.
const ROOT = join(import.meta.dirname, '..');
// The CLI makes config.json from config.default.json when it is missing; pointing it at the shipped file (only read
// here) keeps the repository free of one.
const CLI_ENV = { ...process.env, JOB_BOT_CONFIG: join(ROOT, 'config.default.json') };
const root = mkdtempSync(join(tmpdir(), 'job-bot-daily-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** runDaily with fake steps: `results` maps a command name to its exit code and output. */
async function fakeDaily(results: Record<string, Partial<StepResult>> = {}) {
  const calls: string[] = [];
  const notes: Note[] = [];
  let log = '';
  await runDaily({
    run: async (args) => {
      calls.push(args.join(' '));
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
    now: new Date(2026, 9, 30, 9, 5),
  });
  return { calls, notes, log };
}

describe('runDaily', () => {
  it('runs fetch, check:open --limit 100, ai:score, then notifies, then backs up', async () => {
    const { calls, notes, log } = await fakeDaily({
      fetch: { output: 'old line\n10 postings checked, 1 new.\n' },
      'ai:score': { output: '3 jobs scored, 0 failed.\n' },
    });
    assert.deepEqual(calls, ['fetch', 'check:open --limit 100', 'ai:score', 'notify', 'backup']);
    assert.deepEqual(notes, [
      { title: 'Job Bot', message: '10 postings checked, 1 new. 3 jobs scored, 0 failed.', url: 'http://localhost:3100' },
    ]);
    assert.match(log, /^\n===== 2026-10-30 09:05 =====\n/);
    assert.match(log, /notification: 10 postings checked/);
    assert.doesNotMatch(log, /failed \(see above\)/);
  });

  it('a failing check:open is logged and still notifies (the old daily-fetch.sh test)', async () => {
    const { calls, notes, log } = await fakeDaily({ fetch: { output: '10 postings checked, 1 new.' }, 'check:open': { code: 1 } });
    assert.deepEqual(calls, ['fetch', 'check:open --limit 100', 'ai:score', 'notify', 'backup']);
    assert.match(notes[0].message, /^10 postings checked/);
    assert.match(log, /check:open failed \(see above\)/);
  });

  it('a failed AI review is reported in the notification instead of a score count', async () => {
    const { notes } = await fakeDaily({ fetch: { output: '5 postings checked' }, 'ai:score': { code: 1, output: '7 jobs scored' } });
    assert.equal(notes[0].message, `5 postings checked ${AI_FAILED}`);
  });

  it('a failed fetch skips check:open and ai:score, says so, and still backs up', async () => {
    const { calls, notes } = await fakeDaily({ fetch: { code: 1, output: 'ECONNREFUSED' } });
    assert.deepEqual(calls, ['fetch', 'notify', 'backup']);
    assert.equal(notes[0].message, FETCH_FAILED);
  });

  it('a failed backup only shows in the log', async () => {
    const { calls, log } = await fakeDaily({ backup: { code: 1 } });
    assert.equal(calls.at(-1), 'backup');
    assert.match(log, /backup failed \(see above\)\n$/);
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
  it('runs `node ... src/cli.ts daily` in the repository, with ~/.local/bin on PATH', () => {
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
  });
});

describe('scheduleSnippet', () => {
  it('macOS: a launchd plist that runs scripts/daily-fetch.sh with zsh at 9:00', () => {
    const s = scheduleSnippet({ platform: 'darwin', root: '/Users/me/job bot', node: '/opt/homebrew/bin/node', user: 'me' });
    assert.match(s, /<string>com\.me\.job-bot\.fetch<\/string>/);
    assert.match(s, /<string>\/bin\/zsh<\/string><string>\/Users\/me\/job bot\/scripts\/daily-fetch\.sh<\/string>/);
    assert.match(s, /<key>Hour<\/key><integer>9<\/integer>/);
    assert.match(s, /launchctl bootstrap gui\/\$\(id -u\) ~\/Library\/LaunchAgents\/com\.me\.job-bot\.fetch\.plist/);
  });

  it('Linux: a systemd user service and persistent timer, and a cron line with the session bus', () => {
    const s = scheduleSnippet({ platform: 'linux', root: "/home/me/o'k", node: '/usr/bin/node', user: 'me', uid: 1000 });
    assert.match(s, /^WorkingDirectory=\/home\/me\/o'k$/m);
    assert.match(s, /^ExecStart="\/usr\/bin\/node" --no-warnings --env-file-if-exists=\.env src\/cli\.ts daily$/m);
    assert.match(s, /^OnCalendar=\*-\*-\* 09:00:00\nPersistent=true$/m);
    assert.match(s, /systemctl --user enable --now job-bot-fetch\.timer/);
    assert.match(s, /^DBUS_SESSION_BUS_ADDRESS=unix:path=\/run\/user\/1000\/bus$/m);
    assert.match(s, /^0 9 \* \* \* cd '\/home\/me\/o'\\''k' && '\/usr\/bin\/node' --no-warnings .* daily$/m);
  });

  it('Windows: Register-ScheduledTask in PowerShell (quoted literals) and a schtasks line for cmd.exe', () => {
    const s = scheduleSnippet({
      platform: 'win32',
      root: "C:\\Users\\O'Neil\\job-bot",
      node: 'C:\\Program Files\\nodejs\\node.exe',
      user: 'x',
    });
    assert.match(
      s,
      /-Execute 'C:\\Program Files\\nodejs\\node\.exe' -Argument '--no-warnings --env-file-if-exists=\.env src\/cli\.ts daily'/,
    );
    assert.match(s, /-WorkingDirectory 'C:\\Users\\O''Neil\\job-bot'/);
    assert.match(s, /New-ScheduledTaskTrigger -Daily -At 9am/);
    assert.match(s, /-StartWhenAvailable/);
    assert.ok(
      s.includes(
        'schtasks /Create /F /SC DAILY /ST 09:00 /TN "job-bot daily fetch" /TR "\\"C:\\Program Files\\nodejs\\node.exe\\" --no-warnings \\"C:\\Users\\O\'Neil\\job-bot\\src\\cli.ts\\" daily"',
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
