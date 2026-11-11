import { userInfo } from 'node:os';
import { posix, win32 } from 'node:path';
import { psQuote } from '../notify.ts';
import { ROOT } from '../settings.ts';
import { configuredDailyTime } from './daily.ts';

// schedule:print: the snippet that starts `bot daily --if-due` every 30 minutes with this OS's scheduler, filled in
// with the paths of this clone and this Node; the run itself happens once a day at config.json's dailyTime (default
// 09:00, src/commands/daily.ts), so changing the time needs no new snippet. It only prints; you install it yourself
// (docs/install/<your OS>.md, "Schedule the daily run").

export type ScheduleTarget = {
  /** The daily run's time ("HH:MM"), only shown in the comments: `daily --if-due` reads it itself. */
  time?: string;
  platform: NodeJS.Platform;
  root: string;
  node: string;
  user: string;
  uid?: number;
};

/** A POSIX shell single-quoted word, for a crontab line (where % ends the command unless escaped). */
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`).replace(/%/g, '\\%')}'`;
/** An XML text node. */
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** A systemd unit-file word (double quotes; backslash and quote escaped, % doubled). */
const unitQuote = (s: string) => `"${s.replace(/[\\"]/g, '\\$&').replace(/%/g, '%%')}"`;

const ARGS = '--no-warnings --env-file-if-exists=.env src/cli.ts daily --if-due';
/** Windows starts the run itself at the time (no --if-due): a task left at an older time still runs once a day. */
const WIN_ARGS = '--no-warnings --env-file-if-exists=.env src/cli.ts daily';
/** How often the scheduler starts `daily --if-due`, in minutes. */
export const CHECK_EVERY_MIN = 30;

export function scheduleSnippet(t: ScheduleTarget): string {
  const time = t.time ?? '09:00';
  // Windows opens a console window whenever Task Scheduler starts node.exe, so there the task starts once a day at
  // the time itself instead of checking every 30 minutes; a new time means printing and registering it again.
  const header =
    t.platform === 'win32'
      ? `# Talaash's daily run: Task Scheduler starts \`bot daily\` once a day at ${time} (config.json "dailyTime", or
# the Settings page), or as soon as the computer is on again after a missed run. After changing the time, run
# \`npm run bot -- schedule:print\` again and paste the PowerShell lines again (they replace the task).
`
      : `# Talaash's daily run: the scheduler starts \`bot daily --if-due\` every ${CHECK_EVERY_MIN} minutes, and the run happens once
# a day at ${time} (config.json "dailyTime", or the Settings page), or at the first check after it if the computer was
# asleep or off. Changing the time later needs no change here.
`;
  return header + osSnippet(t, time);
}

function osSnippet(t: ScheduleTarget, time: string): string {
  if (t.platform === 'darwin') {
    const label = `com.${t.user.replace(/[^A-Za-z0-9-]/g, '') || 'me'}.job-bot.fetch`;
    const plist = `~/Library/LaunchAgents/${label}.plist`;
    return `# macOS (launchd): save this as ${plist}
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>${xml(posix.join(t.root, 'scripts', 'daily-fetch.sh'))}</string><string>--if-due</string></array>
  <key>StartInterval</key><integer>${CHECK_EVERY_MIN * 60}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>${xml(posix.join(t.root, 'data', 'launchd.err.log'))}</string>
</dict>
</plist>

# then load it (if an older one is loaded, unload it first: launchctl bootout gui/$(id -u)/${label}):
launchctl bootstrap gui/$(id -u) ${plist}
# To try the whole run once now, whatever the time: npm run bot -- daily
`;
  }
  if (t.platform === 'win32') {
    const cli = win32.join(t.root, 'src', 'cli.ts');
    return `# Windows (Task Scheduler), in PowerShell (-Force replaces an older task):
$action = New-ScheduledTaskAction -Execute ${psQuote(t.node)} -Argument ${psQuote(WIN_ARGS)} -WorkingDirectory ${psQuote(t.root)}
$trigger = New-ScheduledTaskTrigger -Daily -At ${psQuote(time)}
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName 'job-bot daily fetch' -Action $action -Trigger $trigger -Settings $settings -Force
# To try the whole run once now, whatever the time: npm run bot -- daily

# Or in cmd.exe with schtasks (no catch-up after a missed run):
schtasks /Create /F /SC DAILY /ST ${time} /TN "job-bot daily fetch" /TR "\\"${t.node}\\" --no-warnings \\"${cli}\\" daily"
`;
  }
  const bus = t.uid === undefined ? '' : `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${t.uid}/bus\n`;
  return `# Linux (systemd user timer). Save as ~/.config/systemd/user/job-bot-fetch.service:
[Unit]
Description=job-bot daily fetch

[Service]
Type=oneshot
WorkingDirectory=${t.root.replace(/%/g, '%%')}
ExecStart=${unitQuote(t.node)} ${ARGS}

# and as ~/.config/systemd/user/job-bot-fetch.timer (Persistent: a run missed while the computer was off happens at boot):
[Unit]
Description=job-bot daily fetch check, every ${CHECK_EVERY_MIN} minutes

[Timer]
OnCalendar=*:0/${CHECK_EVERY_MIN}
Persistent=true

[Install]
WantedBy=timers.target

# then enable it (again after replacing older files):
systemctl --user daemon-reload && systemctl --user enable --now job-bot-fetch.timer
# To try the whole run once now, whatever the time: npm run bot -- daily

# Or with cron (crontab -e; replace an older 9:00 line). The bus address lets notify-send reach your desktop:
${bus}*/${CHECK_EVERY_MIN} * * * * cd ${shQuote(t.root)} && ${shQuote(t.node)} ${ARGS}
`;
}

/** schedule:print [--os macos|linux|windows]: the snippet for this OS, with config.json's dailyTime in its comments. */
export function schedulePrint(_args: string[], flags: Record<string, string>) {
  const os = flags.os;
  const platform: NodeJS.Platform | undefined =
    os === undefined ? process.platform : ({ macos: 'darwin', linux: 'linux', windows: 'win32' } as const)[os as 'macos'];
  if (!platform) {
    console.log('Usage: schedule:print [--os macos|linux|windows]');
    process.exitCode = 1;
    return;
  }
  let user = 'me';
  try {
    user = userInfo().username;
  } catch {}
  const time = configuredDailyTime();
  process.stdout.write(scheduleSnippet({ platform, root: ROOT, node: process.execPath, user, uid: process.getuid?.(), time }));
}
