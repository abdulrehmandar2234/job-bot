// Runs inside the job page (chrome.scripting.executeScript) when the user clicks. It only reads the page:
// it never changes, fills in, clicks or submits anything. Must stay self-contained (no imports, no closures).
export function collectPage() {
  const meta = (name) => document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.content ?? '';
  const main = document.querySelector('main, [role="main"], article') ?? document.body;
  // A short one-line element named "location" (Greenhouse's job__location), for pages without JobPosting data.
  const locationText =
    [...document.querySelectorAll('[class*="location" i], [id*="location" i]')]
      .filter((el) => !el.closest('form') && !['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName))
      .map((el) => (el.innerText ?? el.textContent ?? '').trim())
      .find((t) => t.length >= 2 && t.length <= 100 && !t.includes('\n')) ?? '';
  return {
    locationText,
    url: location.href,
    title: document.title,
    siteName: meta('og:site_name'),
    jsonLd: [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent ?? ''),
    selection: String(window.getSelection() ?? ''),
    mainText: (main?.innerText ?? '').slice(0, 50000),
  };
}
