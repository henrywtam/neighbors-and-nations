import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGroupStore, publicGroup, memberList } from '../src/groups.js';
import { rowsToObjects } from '../src/sheets.js';
import { emailKey } from '../src/sync-pc.js';

/** In-memory stand-in for the Sheets group tabs. */
function fakeApi(tabs = {}) {
  const state = { tabs: structuredClone(tabs) };
  state.api = {
    rowsToObjects,
    async readOrCreateTab(_id, tab, header) {
      state.tabs[tab] ??= { header, rows: [] };
      return structuredClone(state.tabs[tab]);
    },
    async appendRowsRaw(_id, tab, rows) { state.tabs[tab].rows.push(...rows); },
  };
  return state;
}

const LEADER = { leaderName: 'Sam', leaderEmail: 'Sam@Example.com', groupName: 'Sunset Young Adults', neighborhood: 'Inner Sunset' };

test('create gives a readable code and adds the leader as a member', async () => {
  const s = fakeApi();
  const store = createGroupStore('sheet', s.api);
  await store.init();
  const g = await store.create(LEADER);
  assert.match(g.code, /^SUNSET[2-9]{2}$/);
  assert.equal(g.leaderEmail, 'sam@example.com');
  assert.deepEqual([...store.memberKeys(g.code)], [emailKey('sam@example.com')]);
  assert.equal(publicGroup(g).memberCount, 1);
  assert.equal('leaderEmail' in publicGroup(g), false);
});

test('join: lowercase code works, two emails are one member, rejoining adds nothing', async () => {
  const s = fakeApi();
  const store = createGroupStore('sheet', s.api);
  await store.init();
  const { code } = await store.create(LEADER);
  await store.join(code.toLowerCase(), ['a@x.com', 'a.other@x.com']);
  const again = await store.join(code, ['A@x.com']);
  assert.equal(again.added, 0);
  assert.equal(store.memberKeys(code).size, 3);
  assert.equal(publicGroup(store.get(code)).memberCount, 2);
  await assert.rejects(store.join('NOPE22', ['a@x.com']), { status: 400 });
  await assert.rejects(store.join(code, ['not-an-email']), { status: 400 });
});

test('groups and rosters survive a reload from the tabs', async () => {
  const s = fakeApi();
  const store = createGroupStore('sheet', s.api);
  await store.init();
  const { code } = await store.create(LEADER);
  await store.join(code, ['a@x.com']);

  const reloaded = createGroupStore('sheet', fakeApi(s.tabs).api);
  await reloaded.init();
  const g = publicGroup(reloaded.get(code));
  assert.equal(g.groupName, 'Sunset Young Adults');
  assert.equal(g.memberCount, 2);
});

test('memberList: one entry per join with its email, newest first', async () => {
  const s = fakeApi();
  const store = createGroupStore('sheet', s.api);
  await store.init();
  const { code } = await store.create(LEADER);
  await store.join(code, ['B@x.com']);
  const list = memberList(store.get(code));
  assert.deepEqual(list.map(m => m.email).sort(), ['b@x.com', 'sam@example.com']);
  assert.deepEqual(list.find(m => m.email === 'b@x.com').keys, [emailKey('b@x.com')]);
});
