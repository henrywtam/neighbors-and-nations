import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSheetCache } from '../src/sheet-cache.js';
import { rowsToObjects } from '../src/sheets.js';

const HEADER = ['person_id', 'submitted_at', 'is_test'];

/** In-memory stand-in for src/sheets.js that records every call. */
function fakeApi({ header = HEADER, rows = [], meta = null } = {}) {
  const state = { header: [...header], rows: rows.map(r => [...r]), meta, calls: [], failMeta: false };
  state.api = {
    rowsToObjects,
    async readResponsesFull() { state.calls.push('full'); return { header: [...state.header], rows: state.rows.map(r => [...r]) }; },
    async readResponseRows(_id, from, to) {
      state.calls.push(`rows:${from}-${to}`);
      return state.rows.slice(from - 2, to - 1);
    },
    async readReferenceTabs() { state.calls.push('ref'); return { lists: {}, regionMap: new Map(), approvals: new Map(), raw: 'x' }; },
    async readMeta() {
      state.calls.push('meta');
      if (state.failMeta) throw new Error('boom');
      return state.meta && { ...state.meta };
    },
    async writeMeta(_id, m) { state.calls.push('writeMeta'); state.meta = { ...m }; },
    async writeHeaderCell(_id, col, name) { state.calls.push(`header:${col}`); state.header[col] = name; },
  };
  // Simulate the sync appending rows + bumping Meta
  state.append = (...newRows) => {
    state.rows.push(...newRows);
    state.meta = { ...state.meta, row_count: state.rows.length, last_updated: new Date(Date.now() + state.rows.length).toISOString() };
  };
  return state;
}

test('init bootstraps Meta and adds submission_id header once', async () => {
  const s = fakeApi({ rows: [['1', '2026-10-01T00:00:00Z', 'FALSE'], ['2', '2026-10-03T00:00:00Z', 'FALSE']] });
  const cache = createSheetCache('sheet', s.api);
  await cache.init();
  assert.equal(cache.rowCount, 2);
  assert.deepEqual(cache.header, [...HEADER, 'submission_id', 'email_key']);
  assert.equal(s.meta.row_count, 2);
  assert.equal(s.meta.last_synced_at, '2026-10-03T00:00:00Z');
  assert.ok(s.calls.includes('header:3') && s.calls.includes('header:4'));
});

test('unchanged Meta → one Meta read, no row reads', async () => {
  const s = fakeApi({ rows: [['1', '2026-10-01T00:00:00Z', 'FALSE']] });
  const cache = createSheetCache('sheet', s.api);
  await cache.init();
  s.calls.length = 0;
  assert.equal(await cache.checkForUpdates(), false);
  assert.equal(await cache.checkForUpdates(), false);
  assert.deepEqual(s.calls, ['meta', 'meta']);
});

test('new rows → fetches only the range past the cached count', async () => {
  const s = fakeApi({ rows: [['1', '2026-10-01T00:00:00Z', 'FALSE']] });
  const cache = createSheetCache('sheet', s.api);
  await cache.init();
  s.append(['2', '2026-10-02T00:00:00Z', 'FALSE', 'sub-2'], ['3', '2026-10-02T01:00:00Z', 'FALSE', 'sub-3']);
  s.calls.length = 0;
  assert.equal(await cache.checkForUpdates(), true);
  assert.deepEqual(s.calls, ['meta', 'rows:3-4']);
  assert.equal(cache.rowCount, 3);
  assert.equal(cache.sheetData().responses[2].submission_id, 'sub-3');
});

test('dedup by submission_id and by legacy person_id|submitted_at', async () => {
  const s = fakeApi({ rows: [['1', '2026-10-01T00:00:00Z', 'FALSE']] });
  const cache = createSheetCache('sheet', s.api);
  await cache.init();
  s.append(['2', '2026-10-02T00:00:00Z', 'FALSE', 'sub-2']);
  await cache.checkForUpdates();
  assert.equal(cache.has({ submissionId: 'sub-2' }), true);
  assert.equal(cache.has({ submissionId: 'legacy', personId: '1', submittedAt: '2026-10-01T00:00:00Z' }), true);
  assert.equal(cache.has({ submissionId: 'sub-9', personId: '1', submittedAt: '2026-10-05T00:00:00Z' }), false);
});

test('failed check keeps cached rows; next check catches up', async () => {
  const s = fakeApi({ rows: [['1', '2026-10-01T00:00:00Z', 'FALSE']] });
  const cache = createSheetCache('sheet', s.api);
  await cache.init();
  s.append(['2', '2026-10-02T00:00:00Z', 'FALSE', 'sub-2']);
  s.failMeta = true;
  await assert.rejects(cache.checkForUpdates());
  assert.equal(cache.rowCount, 1);
  s.failMeta = false;
  assert.equal(await cache.checkForUpdates(), true);
  assert.equal(cache.rowCount, 2);
});

test('readOnly init writes nothing', async () => {
  const s = fakeApi({ rows: [['1', '2026-10-01T00:00:00Z', 'FALSE']] });
  await createSheetCache('sheet', s.api).init({ readOnly: true });
  assert.ok(!s.calls.some(c => c.startsWith('header') || c === 'writeMeta'));
});

test('emailKey is case/whitespace-insensitive and blank for no email', async () => {
  const { emailKey } = await import('../src/sync-pc.js');
  assert.equal(emailKey(' Foo@Example.com '), emailKey('foo@example.com'));
  assert.equal(emailKey('foo@example.com').length, 16);
  assert.equal(emailKey(''), '');
  assert.notEqual(emailKey('a@x.com'), emailKey('b@x.com'));
});
