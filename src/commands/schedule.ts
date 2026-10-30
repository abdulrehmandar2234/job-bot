import { userInfo } from 'node:os';
import { posix, win32 } from 'node:path';
import { psQuote } from '../notify.ts';
import { ROOT } from '../settings.ts';

// schedule:print: the snippet that runs `bot daily` every morning at 9:00 with this OS's scheduler, filled in with the
// paths of this clone and this Node. It only prints; you install it yourself (docs/SETUP.md, "The daily fetch").

export type ScheduleTarget = {
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

const ARGS = '--no-warnings --env-file-if-exists=.env src/cli.ts daily';

export function scheduleSnippet(t: ScheduleTarget): string {
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
  <array><string>/bin/zsh</string><string>${xml(posix.join(t.root, 'scripts', 'daily-fetch.sh'))}</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardErrorPath</key><string>${xml(posix.join(t.root, 'data', 'launchd.err.log'))}</string>
</dict>
</plist>

# then load it, and run it once now to try it:
launchctl bootstrap gui/$(id -u) ${plist}
launchctl kickstart gui/$(id -u)/${label}
`;
  }
  if (t.platform === 'win32') {
    const cli = win32.join(t.root, 'src', 'cli.ts');
    return `# Windows (Task Scheduler), in PowerShell. Runs at 9:00, or as soon as possible after a missed 9:00:
$action = New-ScheduledTaskAction -Execute ${psQuote(t.node)} -Argument ${psQuote(ARGS)} -WorkingDirectory ${psQuote(t.root)}
$trigger = New-ScheduledTaskTrigger -Daily -At 9am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName 'job-bot daily fetch' -Action $action -Trigger $trigger -Settings $settings -Force
Start-ScheduledTask -TaskName 'job-bot daily fetch'   # run it once now to try it

# Or in cmd.exe with schtasks (no catch-up after a missed run):
schtasks /Create /F /SC DAILY /ST 09:00 /TN "job-bot daily fetch" /TR "\\"${t.node}\\" --no-warnings \\"${cli}\\" daily"
schtasks /Run /TN "job-bot daily fetch"
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
Description=job-bot daily fetch at 9:00

[Timer]
OnCalendar=*-*-* 09:00:00
Persistent=true

[Install]
WantedBy=timers.target

# then enable it, and run it once now to try it:
systemctl --user daemon-reload && systemctl --user enable --now job-bot-fetch.timer
systemctl --user start job-bot-fetch.service

# Or with cron (crontab -e; a run missed while the computer was off is skipped). The bus address lets notify-send reach your desktop:
${bus}0 9 * * * cd ${shQuote(t.root)} && ${shQuote(t.node)} ${ARGS}
`;
}

/** schedule:print [--os macos|linux|windows] */
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
  process.stdout.write(scheduleSnippet({ platform, root: ROOT, node: process.execPath, user, uid: process.getuid?.() }));
}
