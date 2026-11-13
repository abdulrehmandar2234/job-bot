import type { NextConfig } from 'next';
import { join } from 'node:path';

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // An imported CV (Settings, "Import your CV") is posted to a server action; src/cv/import.ts allows up to 5 MB.
  experimental: { serverActions: { bodySizeLimit: '6mb' } },
  partialPrefetching: true,
  turbopack: {
    // The repo root, not web/: the dashboard imports the bot's pure modules from ../src (profile rules, follow-up rule,
    // AI presets, shared constants). The two packages keep their own lockfiles and node_modules.
    root: join(import.meta.dirname, '..'),
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
};

export default nextConfig;
