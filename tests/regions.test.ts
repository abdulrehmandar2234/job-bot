import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COUNTRIES, effectiveRemoteRules, remoteRules } from '../src/regions.ts';

/** How a remote region text is judged, the way src/match.ts tests it: allow first, then deny, then flag. */
const judge = (r: { allow: string; deny: string; flag: string }, region: string) => {
  if (!new RegExp(r.allow, 'i').test(region)) return new RegExp(r.deny, 'i').test(region) ? 'denied' : 'outside';
  return new RegExp(r.flag, 'i').test(region) ? 'flagged' : 'open';
};

// The hand-written patterns config.json shipped with for Pakistan, before they were computed.
const PK_BEFORE = {
  allow:
    'worldwide|anywhere|global|pakistan|south asia|\\basia\\b|apac|asia[- ]pacific|\\bmena\\b|middle east|gmt ?\\+ ?5|\\bpkt\\b|emea|international',
  deny: '\\b(us|usa|u\\.s\\.?)\\b|united states|north america|americas|canada|\\buk\\b|united kingdom|\\beu\\b|europe|latam|latin america|south america|mexico|brazil|argentina|colombia|india|philippines|australia|germany|poland|spain|portugal|ireland|france|romania|ukraine',
  flag: 'emea|international|not stated',
};

describe('remoteRules', () => {
  it('Pakistan: the same verdicts as the old hand-written patterns', () => {
    const pk = remoteRules('PK', 'Pakistan');
    for (const region of [
      'Worldwide',
      'Anywhere',
      'Pakistan',
      'South Asia',
      'Asia',
      'APAC',
      'Asia-Pacific',
      'MENA',
      'Middle East',
      'EMEA',
      'International',
      'GMT+5',
      'PKT',
      'US',
      'USA',
      'United States',
      'North America',
      'Canada',
      'UK',
      'EU',
      'Europe',
      'LATAM',
      'Brazil',
      'India',
      'Philippines',
      'Australia',
      'Germany',
      'Ukraine',
      'US or Pakistan',
      'Japan',
    ])
      assert.equal(judge(pk, region), judge(PK_BEFORE, region), region);
    // What changed: UTC+5 and the GCC are open; Africa, Turkey and Singapore are named as limited, not just outside.
    assert.equal(judge(pk, 'UTC +5'), 'open');
    assert.equal(judge(pk, 'GCC'), 'open');
    for (const r of ['Africa', 'Turkey', 'Singapore']) assert.equal(judge(pk, r), 'denied', r);
  });

  it('India: India, South Asia, APAC and IST are open; Pakistan, EMEA and the Americas are not', () => {
    const india = remoteRules('in', 'India');
    for (const r of ['India', 'Bengaluru, India', 'South Asia', 'APAC', 'Asia', 'IST', 'GMT+5:30', 'UTC+05:30', 'Worldwide']) {
      assert.notEqual(judge(india, r), 'denied', r);
      assert.notEqual(judge(india, r), 'outside', r);
    }
    for (const r of ['Pakistan', 'EMEA', 'Europe', 'US', 'LATAM', 'Middle East']) assert.equal(judge(india, r), 'denied', r);
    assert.equal(judge(india, 'International'), 'flagged');
    assert.equal(judge(india, 'GMT+5'), 'outside', 'Pakistan time is not India time');
    assert.equal(india.allow.split('|').filter((p) => p === 'india').length, 1, 'its name is listed once');
  });

  it('every country in the table: compiles, allows itself, and is not denied by its own rules', () => {
    for (const [code, c] of Object.entries(COUNTRIES)) {
      const r = remoteRules(code);
      for (const p of Object.values(r)) assert.doesNotThrow(() => new RegExp(p, 'i'), code);
      const name = c.names
        .split('|')[0]
        .replace(/\\b/g, '')
        .replace(/[()?\\]/g, '')
        .replace(/\[.*\]/, 'u');
      assert.equal(new RegExp(r.allow, 'i').test(name), true, `${code} allows "${name}"`);
      assert.equal(new RegExp(r.deny, 'i').test(name), false, `${code} does not deny "${name}"`);
    }
  });

  it('a country outside the table: worldwide jobs and its own name, everything known elsewhere is denied', () => {
    const r = remoteRules('JP', 'Japan');
    assert.equal(judge(r, 'Japan'), 'open');
    assert.equal(judge(r, 'Worldwide'), 'open');
    for (const reg of ['Asia', 'APAC', 'EMEA', 'India', 'Pakistan', 'US']) assert.equal(judge(r, reg), 'denied', reg);
    assert.equal(judge(remoteRules(null), 'Anywhere'), 'open');
    assert.equal(judge(remoteRules(undefined, 'Côte d’Ivoire (Abidjan)'), 'Côte d’Ivoire (Abidjan)'), 'open', 'the name is escaped');
  });

  it('a typed name the table knows under another code is not denied', () => {
    // fromCode missing, remote.from "Pakistan": Pakistan must not end up in the deny list.
    assert.notEqual(judge(remoteRules(null, 'Pakistan'), 'Pakistan'), 'denied');
  });
});

describe('effectiveRemoteRules', () => {
  it('uses config.json patterns where set, computed ones elsewhere (empty = computed)', () => {
    const auto = remoteRules('IN', 'India');
    assert.deepEqual(effectiveRemoteRules({}, 'IN', 'India'), auto);
    assert.deepEqual(effectiveRemoteRules({ allow: 'worldwide', deny: '  ', flag: undefined }, 'IN', 'India'), {
      allow: 'worldwide',
      deny: auto.deny,
      flag: auto.flag,
    });
  });
});
