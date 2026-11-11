# Talaash in a container: the bot CLI, the dashboard (built), Chrome's headless shell for CV and letter PDFs and the
# PostgreSQL client for backups. docker-compose.yml runs it with a PostgreSQL service and a scheduler for the daily run;
# docs/install/docker.md is the guide. Everything personal (config.json, your CV and profile, generated CVs, letters,
# logs, backups and .env) lives in the mounted /app/home, never in the image.
#
# Two stages: `build` installs every package and builds the dashboard; the final image copies only what runs (no
# build-only packages, no build cache), so it stays about half the size.

FROM node:24-bookworm-slim AS base
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NEXT_TELEMETRY_DISABLED=1
# The PostgreSQL 17 client (pg_dump and psql must not be older than the server in docker-compose.yml), from the
# PostgreSQL project's apt repository; tzdata so the daily run follows TZ.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg tzdata \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-17 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
# Dependencies first, so a code change does not reinstall them. --ignore-scripts: the root "prepare" script installs
# git hooks, which a container has no use for.
COPY package.json package-lock.json ./
COPY web/package.json web/package-lock.json web/
RUN npm ci --ignore-scripts && npm ci --prefix web
# Chrome's headless shell (its system libraries are installed in the final image).
RUN npx playwright-core install chromium-headless-shell
COPY . .
# The dashboard's production build. No page queries the database while building; the URL only satisfies modules that
# read it on import. Then the build-only packages and the build cache go.
RUN DATABASE_URL=postgres://build@127.0.0.1:1/none npm --prefix web run build \
 && npm prune --omit=dev --ignore-scripts \
 && npm prune --omit=dev --prefix web \
 && rm -rf web/.next/cache

FROM base
ENV TALAASH_DOCKER=1 \
    JOB_BOT_NOTIFY=off \
    JOB_BOT_CONFIG=/app/home/config.json \
    JOB_BOT_APPLICANT=/app/home/cv/applicant.json \
    JOB_BOT_MASTER=/app/home/cv/master.json \
    JOB_BOT_DATA_DIR=/app/home/data \
    JOB_BOT_ENV_FILE=/app/home/.env \
    JOB_BOT_WEB_ENV_FILE=/app/home/.env
COPY --from=build --chown=node:node /app /app
COPY --from=build --chown=node:node /ms-playwright /ms-playwright
# The system libraries Chrome's headless shell needs.
RUN npx playwright-core install-deps chromium-headless-shell \
 && rm -rf /var/lib/apt/lists/*

# The bot keeps its generated files in folders under /app; they point into /app/home so they survive a rebuild.
# Settings files are moved with the JOB_BOT_* variables above instead: they are saved by rename, which would
# replace a symlink with a file inside the container.
RUN mkdir -p /app/home \
 && rm -rf /app/data /app/applications /app/cv/default /app/cv/original /app/cv/versions \
 && ln -s /app/home/data /app/data \
 && ln -s /app/home/applications /app/applications \
 && ln -s /app/home/cv/default /app/cv/default \
 && ln -s /app/home/cv/original /app/cv/original \
 && ln -s /app/home/cv/versions /app/cv/versions \
 && ln -s /app/home/.env /app/.env \
 && ln -s /app/home/.env /app/web/.env.local \
 && install -m 0755 docker/bot /usr/local/bin/bot \
 && install -m 0755 docker/entrypoint.sh /usr/local/bin/talaash-entrypoint

EXPOSE 3100
ENTRYPOINT ["talaash-entrypoint"]
# The dashboard. It listens on every interface inside the container; docker-compose.yml publishes it on the host's
# 127.0.0.1 only, and the dashboard itself refuses any Host that is not localhost (web/proxy.ts).
CMD ["sh", "-c", "cd /app/web && exec node_modules/.bin/next start -H 0.0.0.0 -p 3100"]
