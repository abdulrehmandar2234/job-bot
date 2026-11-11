// How the user runs a bot command where this dashboard runs: `npm run bot --` in a clone, through compose in the
// Docker image (TALAASH_DOCKER=1, set by the Dockerfile). Server code reads it and passes the text to components.

export const NPM_BOT = 'npm run bot --';
export const DOCKER_BOT = 'docker compose exec app bot';

export const botCommand = (env: Record<string, string | undefined> = process.env) => (env.TALAASH_DOCKER === '1' ? DOCKER_BOT : NPM_BOT);
