// Bayt's country boards, shared by the collector route (app/api/bayt-script/route.ts) and the list page's "Open Bayt"
// link. A route file may only export route handlers, so the mapping lives here. Nothing is read on import.

/** Bayt's country slugs for the Gulf markets it serves; target countries Bayt has no board for are left out. */
export const BAYT_COUNTRY: Record<string, string> = {
  AE: 'uae',
  SA: 'saudi-arabia',
  QA: 'qatar',
  KW: 'kuwait',
  BH: 'bahrain',
  OM: 'oman',
};

/** The Bayt slugs of the configured target countries (codes as config.json `countries` keys), in config order. */
export const baytCountries = (codes: readonly string[]) => codes.map((c) => BAYT_COUNTRY[c.toUpperCase()]).filter(Boolean);

/** Where "Open Bayt" goes: the jobs board of the first target country Bayt serves, else Bayt's home page. */
export function baytUrl(codes: readonly string[]) {
  const [first] = baytCountries(codes);
  return first ? `https://www.bayt.com/en/${first}/jobs/` : 'https://www.bayt.com/en/';
}
