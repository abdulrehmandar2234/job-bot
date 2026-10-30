#!/bin/sh
# Kept for old habits and schedulers: the backup itself is `npm run bot -- backup` (src/backup.ts), on every OS.
cd "$(dirname "$0")/.." || exit 1
exec node --no-warnings --env-file-if-exists=.env src/cli.ts backup
