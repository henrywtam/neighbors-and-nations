import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPartnerStore, parsePartner, publicPartner, matchPartners } from '../src/partners.js';
import { rowsToObjects } from '../src/sheets.js';

const P = (over) => parsePartner({ name: 'X', kind: 'Partner', org: '', side: 'Global', heartbeats: '', countries: '', region: '', skills: '', place: '', description: '', sensitive: 'FALSE', show: 'TRUE', ...over });

// A group of 4: 3 care about trafficking, 2 named Thailand, 1 is in education
const STATE = {
  totalPeople: 4,
  heartbeatCounts: { 'Human Trafficking': { count: 3, total: 4 }, 'Children & Education': { count: 1, total: 4 } },
  vocationCounts: { Education: { count: 1, total: 4 } },
  countryPicks: { Thailand: 2, Mexico: 1 },
  regionReach: { 'East & Southeast Asia': 2, 'Latin America': 1 },
  sfBayCount: 0,
};

test('parsePartner reads sides, lists and flags; blank names are skipped', () => {
  const p = P({ name: ' IJM ', side: 'Both', heartbeats: 'Human Trafficking | Justice & Human Rights', sensitive: 'yes', show: '' });
  assert.equal(p.name, 'IJM');
  assert.deepEqual([p.local, p.global], [true, true]);
  assert.deepEqual(p.heartbeats, ['Human Trafficking', 'Justice & Human Rights']);
  assert.equal(p.sensitive, true);
  assert.equal(p.show, true); // blank show defaults to shown
  assert.equal(parsePartner({ name: '  ' }), null);
});

test('publicPartner never shows a sensitive partner\'s place', () => {
  const p = P({ place: 'Bangkok, Thailand', countries: 'Thailand', region: 'East & Southeast Asia', sensitive: 'TRUE' });
  assert.equal(publicPartner(p).place, 'East & Southeast Asia');
  assert.equal('countries' in publicPartner(p), false);
});

test('matchPartners: reasons in the group\'s own numbers; sensitive partners match on region only', () => {
  const open = P({ name: 'Open', heartbeats: 'Human Trafficking', countries: 'Thailand', region: 'East & Southeast Asia' });
  const hidden = P({ name: 'Hidden', heartbeats: 'Human Trafficking', countries: 'Thailand', region: 'East & Southeast Asia', sensitive: 'TRUE' });
  const [a, b] = matchPartners([open, hidden], STATE);
  assert.deepEqual(a.reasons, ['3 of you care about human trafficking', '2 of you named Thailand']);
  assert.deepEqual(b.reasons, ['3 of you care about human trafficking', '2 of you feel connected to East & Southeast Asia']);
  assert.ok(a.score > b.score);
});

test('matchPartners highlights the best missionary and best partner, then the best of the rest', () => {
  const list = [
    P({ name: 'P1', heartbeats: 'Human Trafficking', countries: 'Thailand' }),
    P({ name: 'P2', heartbeats: 'Human Trafficking' }),
    P({ name: 'P3', heartbeats: 'Human Trafficking' }),
    P({ name: 'M1', kind: 'Missionary', heartbeats: 'Children & Education' }),
    P({ name: 'None', heartbeats: 'Seniors' }),
  ];
  const fits = matchPartners(list, STATE).filter(m => m.fit).map(m => m.partner.name);
  assert.deepEqual(fits.sort(), ['M1', 'P1', 'P2']);
  assert.equal(matchPartners(list, { ...STATE, totalPeople: 0 }).some(m => m.fit), false);
});

test('store seeds an empty Partners tab once, then reads what J&O wrote', async () => {
  const tabs = {};
  const api = {
    rowsToObjects,
    async readOrCreateTab(_id, tab, header) { tabs[tab] ??= { header, rows: [] }; return structuredClone(tabs[tab]); },
    async appendRowsRaw(_id, tab, rows) { tabs[tab].rows.push(...rows); },
  };
  const store = createPartnerStore('sheet', api);
  await store.load();
  assert.equal(store.visible().length, tabs.Partners.rows.length);
  assert.ok(store.visible().some(p => p.kind === 'Missionary' && p.org));

  tabs.Partners.rows = [['Only One', 'Partner', '', 'Local', 'Seniors', '', '', '', 'SF', 'About us', 'FALSE', 'TRUE']];
  await store.load();
  assert.deepEqual(store.visible().map(p => p.name), ['Only One']);
});

test('local partners match people connected to SF and the Bay Area', () => {
  const [m] = matchPartners([P({ name: 'L', side: 'Local', heartbeats: 'Seniors' })], { ...STATE, sfBayCount: 2 });
  assert.deepEqual(m.reasons, ['2 of you feel connected to SF and the Bay Area']);
});
