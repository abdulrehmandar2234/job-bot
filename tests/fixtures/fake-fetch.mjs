// Preloaded (`node --import`) into CLI subprocesses by the tests, so the bot never reaches the network.
// FAKE_FETCH is JSON: { "<url substring>": { "status": 404, "body": "...", "url": "<final url after redirects>" } }.
// Any other URL answers 200 with an empty page ("still open"). FAKE_FETCH_LOG, when set, gets one line per URL.
import { appendFileSync } from 'node:fs';

const routes = JSON.parse(process.env.FAKE_FETCH || '{}');

globalThis.fetch = async (input) => {
  const url = String(input);
  if (process.env.FAKE_FETCH_LOG) appendFileSync(process.env.FAKE_FETCH_LOG, `${url}\n`);
  const key = Object.keys(routes).find((k) => url.includes(k));
  const r = key ? routes[key] : { status: 200, body: '<html><body>Apply now</body></html>' };
  const res = new Response(r.body ?? '', { status: r.status ?? 200 });
  if (r.url) Object.defineProperty(res, 'url', { value: r.url });
  return res;
};
