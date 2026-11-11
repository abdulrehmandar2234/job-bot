#!/bin/sh
# Prepares /app/home (the mounted folder with everything personal) and runs the command as the unprivileged `node`
# user. Runs on every start and only fills in what is missing, so it never touches your files.
set -eu

HOME_DIR=/app/home
mkdir -p "$HOME_DIR/cv/default" "$HOME_DIR/cv/original" "$HOME_DIR/cv/versions" "$HOME_DIR/applications" "$HOME_DIR/data"

# config.json starts as a copy of the shipped settings, as in a clone.
[ -f "$HOME_DIR/config.json" ] || cp /app/config.default.json "$HOME_DIR/config.json"

# The bot's .env (also read by the dashboard). DATABASE_URL comes from docker-compose.yml; the file is where you
# put AI_API_KEY and the optional ADZUNA_* keys.
if [ ! -f "$HOME_DIR/.env" ]; then
  cat > "$HOME_DIR/.env" <<EOF
# Talaash settings for the container. DATABASE_URL is set by docker-compose.yml.
DATABASE_URL=${DATABASE_URL:-}
# AI with an API key (any OpenAI-compatible provider, see docs/ai.md):
# AI_API_KEY=
# Optional Adzuna keys:
# ADZUNA_APP_ID=
# ADZUNA_APP_KEY=
EOF
fi

# The mounted folder belongs to the container's user, so the dashboard and the bot can write to it. On Linux that
# user has uid 1000, usually your own account; set user: in docker-compose.yml if yours differs.
if [ "$(id -u)" = "0" ]; then
  # Only when something in it belongs to someone else (a fresh folder created by Docker as root), not on every start.
  if [ -n "$(find "$HOME_DIR" ! -user node -print -quit)" ]; then chown -R node:node "$HOME_DIR"; fi
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
