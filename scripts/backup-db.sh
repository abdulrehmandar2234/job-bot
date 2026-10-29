#!/bin/bash
# Daily pg_dump of the job_bot database into data/backups/<db>-YYYY-MM-DD.sql.gz, keeping the newest 14.
# Called by scripts/daily-fetch.sh. Env overrides (used by tests): JOB_BOT_BACKUP_DB, JOB_BOT_BACKUP_DIR,
# JOB_BOT_BACKUP_KEEP, JOB_BOT_BACKUP_DATE (YYYY-MM-DD, default today), PGHOST, PGPORT, PGUSER.

set -euo pipefail
cd "$(dirname "$0")/.."

DB="${JOB_BOT_BACKUP_DB:-job_bot}"
DIR="${JOB_BOT_BACKUP_DIR:-data/backups}"
KEEP="${JOB_BOT_BACKUP_KEEP:-14}"
DATE="${JOB_BOT_BACKUP_DATE:-$(date +%F)}"
if ! [[ "$DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "backup: JOB_BOT_BACKUP_DATE must be YYYY-MM-DD, not $DATE" >&2
  exit 1
fi

# pg_dump from PATH, else the newest DBngin install.
PG_DUMP=$(command -v pg_dump || ls -1d /Users/Shared/DBngin/postgresql/*/bin/pg_dump 2>/dev/null | sort -V | tail -n 1 || true)
if [ -z "$PG_DUMP" ]; then
  echo "backup: pg_dump not found (PATH or /Users/Shared/DBngin/postgresql/*/bin)" >&2
  exit 1
fi

mkdir -p "$DIR"
OUT="$DIR/$DB-$DATE.sql.gz"
# Dump to a temp file first, so a failed dump never replaces a good backup.
TMP="$OUT.tmp"
trap 'rm -f "$TMP"' EXIT
"$PG_DUMP" -h "${PGHOST:-127.0.0.1}" -p "${PGPORT:-5432}" -U "${PGUSER:-postgres}" --no-owner "$DB" | gzip > "$TMP"
mv "$TMP" "$OUT"
echo "backup: $OUT ($(du -h "$OUT" | cut -f1 | tr -d ' '))"

# Dated names sort chronologically; delete everything past the newest $KEEP.
ls -1 "$DIR"/"$DB"-????-??-??.sql.gz | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do
  rm -f "$old"
  echo "backup: removed $old"
done
