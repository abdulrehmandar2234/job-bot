import { buildProfile, profileGaps as gapsOf, remoteFrom, REQUIRED_PROFILE, type MasterContact } from '../../src/profile.ts';
import type { Config } from '../../src/settings.ts';

// Target markets and profile completeness for the dashboard, from config.json and cv/applicant.json. The files are
// read by lib/profile.ts; the rules are the bot's own (src/profile.ts). The files here are unvalidated JSON, which
// the bot's rules accept: they only read text fields.

export type MarketCountry = { code: string; name: string; label: string; needsVisa: boolean };
export type Market = { countries: MarketCountry[]; remote: boolean; remoteFrom: string | null };

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);

/** The emoji flag of an ISO 3166-1 alpha-2 code ("AE" -> 🇦🇪), or a globe for anything else. */
export function flag(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return '🌍';
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/** Target countries, remote search and the remote-from country, as the bot resolves them (src/profile.ts remoteFrom). */
export function market(config: Json | null, applicant: Json | null): Market {
  const countries = isObj(config?.countries) ? config.countries : {};
  const remote = isObj(config?.remote) ? config.remote : {};
  const linkedin = isObj(config?.linkedin) ? config.linkedin : {};
  return {
    countries: Object.entries(countries).map(([code, c]) => {
      const o = isObj(c) ? c : {};
      const name = str(o.name) ?? code;
      return { code, name, label: str(o.label) ?? name, needsVisa: o.needsVisa !== false };
    }),
    remote: remote.enabled !== false && !!config,
    remoteFrom: remoteFrom({ remote, linkedin } as unknown as Pick<Config, 'remote' | 'linkedin'>, buildProfile(applicant ?? {})),
  };
}

/** Country filter and card labels: "🇦🇪 UAE", ..., "🌍 Remote (from Pakistan)". */
export function countryLabels(m: Market): Record<string, string> {
  const out: Record<string, string> = Object.fromEntries(m.countries.map((c) => [c.code, `${flag(c.code)} ${c.label}`]));
  if (m.remote) out.RM = m.remoteFrom ? `🌍 Remote (from ${m.remoteFrom})` : '🌍 Remote';
  return out;
}

/** The dashboard's subtitle, e.g. "UAE · Saudi Arabia · Netherlands with visa sponsorship, plus remote roles open to Pakistan". */
export function marketLine(m: Market): string {
  // Countries needing a visa first, as one group ("UAE · Saudi Arabia · Netherlands with visa sponsorship"), then
  // the others ("Pakistan onsite"): "UAE · Netherlands with visa sponsorship · Pakistan onsite, plus remote roles…".
  const names = (needsVisa: boolean) =>
    m.countries
      .filter((c) => c.needsVisa === needsVisa)
      .map((c) => c.name)
      .join(' · ');
  const parts = [names(true) && `${names(true)} with visa sponsorship`, names(false) && `${names(false)} onsite`].filter(Boolean);
  let line = parts.join(' · ');
  if (m.remote) {
    const remote = m.remoteFrom ? `remote roles open to ${m.remoteFrom}` : 'remote roles';
    line = line ? `${line}, plus ${remote}` : remote.charAt(0).toUpperCase() + remote.slice(1);
  }
  return line || 'No target countries yet: add them in Settings';
}

// ---- Profile completeness (src/profile.ts buildProfile + profileGaps) ----

export { REQUIRED_PROFILE, type MasterContact };
export type ProfileField = (typeof REQUIRED_PROFILE)[number];

/** Required profile fields still empty after the CV fallbacks (name, email and location may come from the CV). */
export const profileGaps = (app: Json, master: MasterContact = {}): ProfileField[] => gapsOf(buildProfile(app, master));

export const PROFILE_LABEL: Record<ProfileField, string> = {
  fullName: 'full name',
  email: 'email',
  location: 'city and country',
  countryCode: 'country code',
  languages: 'languages',
};
