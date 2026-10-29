import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.ts';
import { duplicateLinks, normCompany, normTitle, type DedupeRow } from '../src/db.ts';

const row = (o: Partial<DedupeRow>): DedupeRow => ({
  id: 'x', company: 'Acme', title: 'Senior Backend Engineer', country: 'AE', source: 'greenhouse', status: 'new',
  first_seen_at: new Date('2026-10-01'), ...o,
});

describe('normCompany / normTitle', () => {
  it('ignores legal suffixes and domains', () => {
    assert.equal(normCompany('Tether Operations Limited'), normCompany('Tether.io'));
    assert.equal(normCompany('Acme Technologies LLC'), normCompany('acme'));
    assert.equal(normCompany('Foo B.V.'), normCompany('Foo'));
    assert.equal(normCompany('Adyen N.V.'), normCompany('Adyen'));
  });
  it('normalises common title spellings', () => {
    assert.equal(normTitle('Sr. Full-Stack Developer'), normTitle('Senior Fullstack Developer'));
    assert.equal(normTitle('Front End Engineer (Remote)'), normTitle('Frontend Engineer'));
    assert.notEqual(normTitle('Backend Engineer'), normTitle('Frontend Engineer'));
  });
});

describe('duplicateLinks', () => {
  it('links the same job from several sites to the most direct source', () => {
    const links = duplicateLinks([
      row({ id: 'linkedin:1', source: 'linkedin' }),
      row({ id: 'gh:1', source: 'greenhouse', company: 'Acme Inc' }),
      row({ id: 'bayt:1', source: 'bayt', title: 'Sr Backend Engineer' }),
    ]);
    assert.deepEqual(links.sort(), [['bayt:1', 'gh:1'], ['linkedin:1', 'gh:1']]);
  });

  it('keeps the copy the user already acted on as primary', () => {
    const links = duplicateLinks([
      row({ id: 'gh:1', source: 'greenhouse' }),
      row({ id: 'linkedin:1', source: 'linkedin', status: 'applied' }),
    ]);
    assert.deepEqual(links, [['gh:1', 'linkedin:1']]);
  });

  it('breaks source ties by first seen', () => {
    const links = duplicateLinks([
      row({ id: 'li:new', source: 'linkedin', first_seen_at: new Date('2026-10-05') }),
      row({ id: 'li:old', source: 'linkedin', first_seen_at: new Date('2026-10-01') }),
    ]);
    assert.deepEqual(links, [['li:new', 'li:old']]);
  });

  it('treats the same title in two countries as two jobs', () => {
    assert.deepEqual(duplicateLinks([row({ id: 'a', country: 'AE' }), row({ id: 'b', country: 'SA' })]), []);
  });

  it('joins a remote copy to the onsite posting', () => {
    const links = duplicateLinks([row({ id: 'onsite', country: 'AE' }), row({ id: 'remote', country: 'RM', source: 'himalayas' })]);
    assert.deepEqual(links, [['remote', 'onsite']]);
  });

  it('groups remote-only copies together', () => {
    const links = duplicateLinks([
      row({ id: 'r1', country: 'RM', source: 'remotive' }),
      row({ id: 'r2', country: 'RM', source: 'himalayas' }),
    ]);
    assert.deepEqual(links, [['r1', 'r2']]); // Himalayas ranks above Remotive
  });

  it('leaves different jobs alone', () => {
    assert.deepEqual(duplicateLinks([row({ id: 'a' }), row({ id: 'b', title: 'Frontend Engineer' }), row({ id: 'c', company: 'Other' })]), []);
  });
});
