import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processResponses, parsePlaceValue } from '../src/processor.js';

// ---------------------------------------------------------------------------
// Minimal mock geonames (no file I/O needed for processor tests)
// ---------------------------------------------------------------------------

const mockGeonames = {
  countryNameToCode: {
    Thailand: 'TH',
    Kenya: 'KE',
    Philippines: 'PH',
  },
  lookupCity(cityName, countryName) {
    const db = {
      'Bangkok|Thailand': { lat: 13.75398, lng: 100.50144, population: 10539000 },
      'Nairobi|Kenya': { lat: -1.28333, lng: 36.81667, population: 4397000 },
      'Manila|Philippines': { lat: 14.5958, lng: 120.9772, population: 1780000 },
    };
    return db[`${cityName}|${countryName}`] ?? null;
  },
};

// ---------------------------------------------------------------------------
// makeSheetData helper — returns minimal valid SheetData
// ---------------------------------------------------------------------------

function makeSheetData(overrides = {}) {
  return {
    responses: [],
    lists: {},
    regionMap: new Map(),
    cityFixes: new Map(),
    approvals: new Map(),
    readAt: new Date('2026-11-01T00:00:00Z'),
    ...overrides,
  };
}

const defaultConfig = {
  showTestRows: false,
};

// ---------------------------------------------------------------------------
// Helper to build a minimal response row
// ---------------------------------------------------------------------------

function makeRow(overrides = {}) {
  return {
    person_id: 'P001',
    submitted_at: '2026-11-01T10:00:00Z',
    is_test: 'FALSE',
    vocation_1: 'Student',
    heartbeat_1: 'Education Access',
    connect_1_place: 'Thailand',
    connect_1_city: '',
    connect_2_place: '',
    connect_2_city: '',
    connect_3_place: '',
    connect_3_city: '',
    connect_where_i_live: 'FALSE',
    lives_area: '',
    lives_place: '',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// 1. Deduplication: person P1 has two rows, processor keeps the later one
test('deduplication keeps the latest row per person_id', () => {
  const earlier = makeRow({
    person_id: 'P1',
    submitted_at: '2026-11-01T10:00:00Z',
    connect_1_place: 'Kenya',
  });
  const later = makeRow({
    person_id: 'P1',
    submitted_at: '2026-11-05T10:00:00Z',
    connect_1_place: 'Thailand',
  });

  const sheetData = makeSheetData({ responses: [earlier, later] });
  const state = processResponses(sheetData, defaultConfig, mockGeonames);

  assert.equal(state.totalPeople, 1, 'should count P1 as 1 person');
  assert.equal(state.countryPicks.get('Thailand'), 1, 'should use later row (Thailand)');
  assert.equal(state.countryPicks.get('Kenya'), undefined, 'earlier row (Kenya) should be discarded');
});

// 2. is_test exclusion
test('is_test=TRUE row excluded when showTestRows=false', () => {
  const testRow = makeRow({ is_test: 'TRUE' });
  const sheetData = makeSheetData({ responses: [testRow] });
  const state = processResponses(sheetData, { showTestRows: false }, mockGeonames);
  assert.equal(state.totalPeople, 0);
});

test('is_test=TRUE row included when showTestRows=true', () => {
  const testRow = makeRow({ is_test: 'TRUE' });
  const sheetData = makeSheetData({ responses: [testRow] });
  const state = processResponses(sheetData, { showTestRows: true }, mockGeonames);
  assert.equal(state.totalPeople, 1);
});

// 3. Place parsing
test('parsePlaceValue: "SF: Mission" → type sf', () => {
  const result = parsePlaceValue('SF: Mission');
  assert.deepEqual(result, { type: 'sf', value: 'Mission' });
});

test('parsePlaceValue: "East Bay: Oakland" → type bayarea', () => {
  const result = parsePlaceValue('East Bay: Oakland');
  assert.deepEqual(result, { type: 'bayarea', value: 'Oakland' });
});

test('parsePlaceValue: "Region: Middle East" → type region', () => {
  const result = parsePlaceValue('Region: Middle East');
  assert.deepEqual(result, { type: 'region', value: 'Middle East' });
});

test('parsePlaceValue: "Thailand" → type country', () => {
  const result = parsePlaceValue('Thailand');
  assert.deepEqual(result, { type: 'country', value: 'Thailand' });
});

test('"SF: Mission" increments sfBayCount', () => {
  const row = makeRow({ connect_1_place: 'SF: Mission' });
  const state = processResponses(makeSheetData({ responses: [row] }), defaultConfig, mockGeonames);
  assert.equal(state.sfBayCount, 1);
  assert.equal(state.countryPicks.size, 0);
});

test('"Region: Middle East" goes to regionPicks', () => {
  const row = makeRow({ connect_1_place: 'Region: Middle East' });
  const state = processResponses(makeSheetData({ responses: [row] }), defaultConfig, mockGeonames);
  assert.equal(state.regionPicks.get('Middle East'), 1);
  assert.equal(state.countryPicks.size, 0);
});

test('"Thailand" goes to countryPicks', () => {
  const row = makeRow({ connect_1_place: 'Thailand' });
  const state = processResponses(makeSheetData({ responses: [row] }), defaultConfig, mockGeonames);
  assert.equal(state.countryPicks.get('Thailand'), 1);
});

// 4. connect_where_i_live=TRUE with lives_area=SF adds lives_place
test('connect_where_i_live=TRUE with lives_area not Elsewhere adds lives_place', () => {
  const row = makeRow({
    connect_1_place: '',
    connect_where_i_live: 'TRUE',
    lives_area: 'San Francisco',
    lives_place: 'SF: Mission',
  });
  const state = processResponses(makeSheetData({ responses: [row] }), defaultConfig, mockGeonames);
  assert.equal(state.sfBayCount, 1);
});

test('connect_where_i_live=TRUE with lives_area=Elsewhere is ignored', () => {
  const row = makeRow({
    connect_1_place: '',
    connect_where_i_live: 'TRUE',
    lives_area: 'Elsewhere',
    lives_place: 'SF: Mission',
  });
  const state = processResponses(makeSheetData({ responses: [row] }), defaultConfig, mockGeonames);
  assert.equal(state.sfBayCount, 0);
});

// 5. Country double-count: one person picks Thailand twice → counts once
test('country picked twice by same person counts once', () => {
  const row = makeRow({
    connect_1_place: 'Thailand',
    connect_2_place: 'Thailand',
  });
  const state = processResponses(makeSheetData({ responses: [row] }), defaultConfig, mockGeonames);
  assert.equal(state.countryPicks.get('Thailand'), 1);
});

// 6. Region pick doesn't add to country picks
test('region pick does not add to countryPicks', () => {
  const row = makeRow({ connect_1_place: 'Region: Africa' });
  const state = processResponses(makeSheetData({ responses: [row] }), defaultConfig, mockGeonames);
  assert.equal(state.countryPicks.size, 0);
  assert.equal(state.regionPicks.get('Africa'), 1);
});

// 7. "Other" with blank text → label "Other"
test('"Other" label in heartbeat counts toward "Other"', () => {
  const row = makeRow({ heartbeat_1: 'Other' });
  const state = processResponses(makeSheetData({ responses: [row] }), defaultConfig, mockGeonames);
  assert.equal(state.heartbeatCounts.get('Other')?.count, 1);
});

// 8. Unapproved write-in → counted as "Other"
test('unapproved write-in counted as Other', () => {
  const row = makeRow({ vocation_1: 'Ninja' });
  // 'ninja' is not in approvals → treated as standard label (pass through)
  // But if we add it to approvals with approved=false → should become Other
  const approvals = new Map([['ninja', { approved: false, showAs: null }]]);
  const state = processResponses(
    makeSheetData({ responses: [row], approvals }),
    defaultConfig,
    mockGeonames,
  );
  assert.equal(state.vocationCounts.get('Other')?.count, 1);
  assert.equal(state.vocationCounts.get('Ninja'), undefined);
});

// 9. Approved write-in with showAs → merged into showAs label
test('approved write-in with showAs merges into showAs label', () => {
  const row = makeRow({ vocation_1: 'fighting injustice' });
  const approvals = new Map([
    ['fighting injustice', { approved: true, showAs: 'Poverty & Economic Justice' }],
  ]);
  const state = processResponses(
    makeSheetData({ responses: [row], approvals }),
    defaultConfig,
    mockGeonames,
  );
  assert.equal(state.vocationCounts.get('Poverty & Economic Justice')?.count, 1);
  assert.equal(state.vocationCounts.get('fighting injustice'), undefined);
});

// 10. Approved write-in with showAs="" → appears as own label
test('approved write-in with blank showAs appears under its own text', () => {
  const row = makeRow({ vocation_1: 'Urban Farmer' });
  const approvals = new Map([
    ['urban farmer', { approved: true, showAs: null }],
  ]);
  const state = processResponses(
    makeSheetData({ responses: [row], approvals }),
    defaultConfig,
    mockGeonames,
  );
  assert.equal(state.vocationCounts.get('Urban Farmer')?.count, 1);
});

// 11. Percentages: 10 people answered vocation q, 4 picked "Student"
test('vocationCounts.total equals number of people who answered vocation question', () => {
  // 10 rows: 4 pick Student, 6 pick other things
  const rows = [];
  for (let i = 1; i <= 10; i++) {
    rows.push(makeRow({
      person_id: `P${i}`,
      submitted_at: `2026-11-0${Math.min(i, 9)}T10:00:00Z`,
      vocation_1: i <= 4 ? 'Student' : 'Healthcare',
    }));
  }
  const state = processResponses(makeSheetData({ responses: rows }), defaultConfig, mockGeonames);
  assert.equal(state.vocationCounts.get('Student')?.total, 10, 'total should be 10 (all answered)');
  assert.equal(state.vocationCounts.get('Student')?.count, 4, 'count should be 4');
});

// Extra: SF + Bay Area both count toward sfBayCount but only once per person
test('SF and Bay Area picks count once per person toward sfBayCount', () => {
  const row = makeRow({
    connect_1_place: 'SF: Mission',
    connect_2_place: 'East Bay: Oakland',
  });
  const state = processResponses(makeSheetData({ responses: [row] }), defaultConfig, mockGeonames);
  assert.equal(state.sfBayCount, 1, 'one person = sfBayCount 1 even with multiple SF/Bay picks');
});

// Extra: rows with no answers are skipped
test('row with no answers at all is skipped (invalidRowCount++)', () => {
  const row = {
    person_id: 'P999',
    submitted_at: '2026-11-01T10:00:00Z',
    is_test: 'FALSE',
    vocation_1: '',
    heartbeat_1: '',
    connect_1_place: '',
    lives_place: '',
  };
  const state = processResponses(makeSheetData({ responses: [row] }), defaultConfig, mockGeonames);
  assert.equal(state.totalPeople, 0);
  assert.equal(state.invalidRowCount, 1);
});
