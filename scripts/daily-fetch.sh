#!/bin/zsh
# Run by launchd every morning (~/Library/LaunchAgents/com.abdulrehman.job-bot.fetch.plist).
# Fetches jobs into Postgres, marks closed postings expired, lets the local Claude CLI review new matches, logs to data/fetch.log
# and shows a macOS notification.

cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

LOG=data/fetch.log
print "\n===== $(date '+%Y-%m-%d %H:%M') =====" >> "$LOG"

if node --no-warnings --env-file-if-exists=.env src/cli.ts fetch >> "$LOG" 2>&1; then
  # Dead-link check: postings that have closed move to `expired`. Best-effort, like the AI review below.
  node --no-warnings --env-file-if-exists=.env src/cli.ts check:open --limit 100 >> "$LOG" 2>&1 || print "check:open failed (see above)" >> "$LOG"
  # AI review is a bonus: a failure here (e.g. Claude signed out) must not hide the fetch result.
  if node --no-warnings --env-file-if-exists=.env src/cli.ts ai:score >> "$LOG" 2>&1; then
    SCORED=$(grep -E '^[0-9]+ jobs scored' "$LOG" | tail -n 1)
  else
    SCORED="AI review failed (is Claude signed in? See data/fetch.log)"
  fi
  SUMMARY=$(grep 'postings checked' "$LOG" | tail -n 1)
  osascript -e "display notification \"$SUMMARY $SCORED\" with title \"Job Bot\" subtitle \"Open http://localhost:3100\""
else
  osascript -e 'display notification "Fetch failed — is PostgreSQL (DBngin) running? See data/fetch.log" with title "Job Bot"'
fi

# Daily database backup (keeps 14). Runs after the notification, so a failed backup only shows in the log.
scripts/backup-db.sh >> "$LOG" 2>&1 || print "backup failed (see above)" >> "$LOG"
