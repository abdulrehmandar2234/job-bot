// Bayt collector — runs inside a bayt.com tab, started by the "Bayt → Job Bot" bookmarklet on the dashboard
// (served from http://localhost:3100/api/bayt-script) or by Claude through the Chrome extension.
// Bayt blocks direct requests from the bot (Cloudflare 403), so jobs are read from inside the browser
// and posted to the local dashboard (http://localhost:3100/api/import), where `bot add` scores them.
// Chrome asks once to allow bayt.com to reach localhost ("local network access").
// Progress: the box in the page corner, and window.__bayt (phase, links, jobs, done, errors, result).

(() => {
  if (window.__bayt && !window.__bayt.done) return 'already running';

  const KEYWORDS = ['laravel', 'php-developer', 'node-js', 'react-js', 'full-stack-developer', 'mern-stack', 'next-js', 'nestjs', 'vue-js'];
  const COUNTRIES = ['uae', 'saudi-arabia'];
  const MAX_AGE_DAYS = 14;
  const INCLUDE = /engineer|developer|full-?stack|back-?end|front-?end|software|web|php|laravel|node|react|programmer/i;
  const EXCLUDE = /data-scien|machine-learning|-ml-|ios|android|mobile|-qa-|quality|-test|-sre-|devops|security|intern|graduate|trainee|manager|director|head-of|sales|support|analyst|designer|embedded|hardware|golang|-java-|net-|dotnet|c-sharp|python|data-engineer|react-native|wordpress|shopify|marketing|salesforce|-sap-|oracle|dynamics/i;

  // Background tabs throttle setTimeout; a MessageChannel tick is not throttled.
  const ch = new MessageChannel();
  const tick = () => new Promise((r) => { ch.port1.onmessage = r; ch.port2.postMessage(0); });
  const parse = (html) => new DOMParser().parseFromString(html, 'text/html');
  const S = (window.__bayt = { phase: 'links', links: [], jobs: [], done: false, errors: [] });

  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:320px;padding:12px 14px;'
    + 'border-radius:10px;background:#18181b;color:#fafafa;font:13px/1.45 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3)';
  document.body.appendChild(box);
  const show = (html) => { box.innerHTML = `<b>Job Bot · Bayt</b><br>${html}`; };
  show('Starting…');

  (async () => {
    const links = new Set();
    let searched = 0;
    for (const c of COUNTRIES) for (const k of KEYWORDS) {
      searched++;
      show(`Searching ${c} · ${k} (${searched}/${COUNTRIES.length * KEYWORDS.length})<br>${links.size} jobs found so far`);
      for (const page of [1, 2]) {
        try {
          const res = await fetch(`/en/${c}/jobs/${k}-jobs/${page > 1 ? `?page=${page}` : ''}`);
          if (!res.ok) { S.errors.push(`${res.status} ${c}/${k}`); break; }
          const found = [...parse(await res.text()).querySelectorAll(`a[href^="/en/${c}/jobs/"]`)]
            .map((a) => a.getAttribute('href')).filter((h) => /-\d{6,}\/$/.test(h));
          found.forEach((h) => links.add(h));
          if (found.length < 15) break;
        } catch (e) { S.errors.push(String(e)); }
        await tick();
      }
    }
    // The slug carries the title, so non-developer jobs are dropped before their (slow) pages are loaded.
    S.links = [...links].filter((h) => { const s = h.split('/').slice(-2)[0]; return INCLUDE.test(s) && !EXCLUDE.test(s); });

    S.phase = 'jobs';
    const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
    const queue = [...S.links];
    let read = 0;
    const worker = async () => {
      for (let href = queue.shift(); href; href = queue.shift()) {
        try {
          const doc = parse(await (await fetch(href)).text());
          const jp = [...doc.querySelectorAll('script[type="application/ld+json"]')]
            .map((s) => { try { return JSON.parse(s.textContent); } catch { return null; } }).flat()
            .find((x) => x && x['@type'] === 'JobPosting');
          if (jp && !(jp.datePosted && new Date(jp.datePosted).getTime() < cutoff)) {
            const loc = [jp.jobLocation].flat().map((l) => [l?.address?.addressLocality,
              { AE: 'UAE', SA: 'Saudi Arabia' }[l?.address?.addressCountry] ?? l?.address?.addressCountry].filter(Boolean).join(', ')).join(' / ');
            S.jobs.push({
              source: 'bayt', company: jp.hiringOrganization?.name || 'Unknown', title: jp.title, location: loc,
              url: location.origin + href, description: parse(jp.description || '').body.textContent.trim(), posted_at: jp.datePosted || null,
            });
          }
        } catch (e) { S.errors.push(String(e)); }
        read++;
        show(`Reading job pages ${read}/${S.links.length} (Bayt is slow, ~20s each)<br>${S.jobs.length} fresh developer jobs`
          + '<br><small>Keep this tab open.</small>');
      }
    };
    await Promise.all([worker(), worker(), worker()]);

    S.phase = 'import';
    show(`Sending ${S.jobs.length} jobs to the dashboard…`);
    try {
      const r = await fetch('http://localhost:3100/api/import', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(S.jobs),
      });
      S.result = await r.json();
      show(`Done ✓ ${S.result.received ?? 0} sent, <b>${S.result.matched ?? 0} matched</b> your profile.`
        + '<br><a href="http://localhost:3100" target="_blank" style="color:#7dd3fc">Open dashboard ↗</a>');
    } catch (e) {
      S.errors.push(`import: ${e}`);
      show('Could not reach the dashboard. Is <code>npm run web</code> running, and did you allow local network access?');
    }
    S.done = true;
  })();
  return 'started';
})();
