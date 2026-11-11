#!/bin/zsh
# Run by launchd every morning (~/Library/LaunchAgents/com.<you>.job-bot.fetch.plist, see docs/install/macos.md "Schedule the daily run").
# The work itself is `bot daily` (src/commands/daily.ts), the same on every OS: fetch, check:open, ai:score, a
# notification and the backup, logged to data/fetch.log. This wrapper only gives launchd's bare environment a PATH
# with node (and claude, pg_dump) on it.

cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

if ! command -v node >/dev/null; then
  mkdir -p data
  print "\n===== $(date '+%Y-%m-%d %H:%M') =====\nnode not found on PATH ($PATH)" >> data/fetch.log
  osascript -e 'display notification "Daily fetch failed: node not found. See data/fetch.log" with title "Talaash"'
  exit 1
fi
exec node --no-warnings --env-file-if-exists=.env src/cli.ts daily
