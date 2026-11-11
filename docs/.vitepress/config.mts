// The documentation site (VitePress): the Markdown pages of docs/ with a sidebar, search and dark mode.
// `npm run docs` serves it on http://localhost:3300; .github/workflows/docs.yml builds it on every pull request and
// publishes it to GitHub Pages from main. docs/README.md is the start page (index.html), so the same files read well
// on GitHub too. tests/docs.test.ts checks that every page is in the sidebar.
import { defineConfig } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';

const REPO = 'https://github.com/abdulrehmandar2234/talaash';

export default withMermaid(
  defineConfig({
    title: 'Talaash',
    description: 'A local job-search assistant: finds, scores and prepares software jobs. You apply yourself.',
    base: '/talaash/',
    cleanUrls: true,
    lastUpdated: true,
    rewrites: { 'README.md': 'index.md' },
    srcExclude: ['node_modules/**'],
    // Links to your own dashboard (http://localhost:3100) only work on your computer; every other dead link fails the build.
    ignoreDeadLinks: 'localhostLinks',
    head: [['meta', { name: 'theme-color', content: '#0f766e' }]],
    themeConfig: {
      nav: [
        { text: 'Quickstart', link: '/quickstart' },
        { text: 'Features', link: '/features' },
        { text: 'CLI', link: '/cli' },
        { text: 'GitHub', link: REPO },
      ],
      sidebar: [
        {
          text: 'Getting started',
          items: [
            { text: 'Introduction', link: '/' },
            { text: 'Quickstart', link: '/quickstart' },
            { text: 'Install on macOS', link: '/install/macos' },
            { text: 'Install on Linux', link: '/install/linux' },
            { text: 'Install on Windows', link: '/install/windows' },
            { text: 'Run with Docker', link: '/install/docker' },
          ],
        },
        {
          text: 'Make it yours',
          items: [
            { text: 'Your CV and profile', link: '/your-cv-and-profile' },
            { text: 'Configuration', link: '/configuration' },
            { text: 'AI: Claude CLI or API key', link: '/ai' },
          ],
        },
        {
          text: 'Use it',
          items: [
            { text: 'Daily use', link: '/daily-use' },
            { text: 'Features', link: '/features' },
            { text: 'CLI reference', link: '/cli' },
          ],
        },
        {
          text: 'Under the hood',
          items: [{ text: 'How it works', link: '/how-it-works' }],
        },
        {
          text: 'Help',
          items: [
            { text: 'Troubleshooting', link: '/troubleshooting' },
            { text: 'Updating', link: '/updating' },
          ],
        },
      ],
      outline: { level: [2, 3], label: 'On this page' },
      search: { provider: 'local' },
      socialLinks: [{ icon: 'github', link: REPO }],
      editLink: { pattern: `${REPO}/edit/main/docs/:path`, text: 'Edit this page on GitHub' },
      footer: { message: 'MIT licensed. Talaash never applies on your behalf.' },
    },
  }),
);
