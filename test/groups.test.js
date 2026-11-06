import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGroupStore, publicGroup, memberList, maskEmail, codeFromName } from '../src/groups.js';
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

test('codes come from the CG name', () => {
  assert.equal(codeFromName('Sunset Young Adults'), 'SUNSETYA');
  assert.equal(codeFromName('Mission CG'), 'MISSION');
  assert.equal(codeFromName('The Richmond Community Group'), 'THER');
  assert.equal(codeFromName('Noe Valley Families & Friends'), 'NOEVFF');
  assert.equal(codeFromName('!!!'), 'GROUP');
});

test('create gives a readable code and adds the leader as a member', async () => {
  const s = fakeApi();
  const store = createGroupStore('sheet', s.api);
  await store.init();
  const g = await store.create(LEADER);
  assert.equal(g.code, 'SUNSETYA');
  assert.equal(g.leaderEmail, 'sam@example.com');
  assert.deepEqual([...store.memberKeys(g.code)], [emailKey('sam@example.com')]);
  assert.deepEqual(publicGroup(g), { code: g.code, groupName: 'Sunset Young Adults' });
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
  assert.equal(memberList(store.get(code)).length, 2);
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
  assert.equal(publicGroup(reloaded.get(code)).groupName, 'Sunset Young Adults');
  assert.equal(memberList(reloaded.get(code)).length, 2);
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

test('names are unique; codes that collide get a number, even when created at once', async () => {
  const s = fakeApi();
  const store = createGroupStore('sheet', s.api);
  await store.init();
  await assert.rejects(store.create({ ...LEADER, groupName: 'x'.repeat(81) }), { status: 400 });
  await assert.rejects(store.create({ ...LEADER, leaderEmail: `${'a'.repeat(250)}@x.com` }), { status: 400 });

  const names = ['Sunset Young Adults', 'Sunset Young Artists', 'Sunset Yellow Apples'];
  const made = await Promise.all(names.map(groupName => store.create({ ...LEADER, groupName })));
  assert.deepEqual(made.map(g => g.code), ['SUNSETYA', 'SUNSETYA2', 'SUNSETYA3']);

  // Same name, different spacing or case: rejected, even when sent at the same moment
  const dupes = await Promise.allSettled([store.create({ ...LEADER, groupName: 'sunset  young adults!' }), store.create({ ...LEADER, groupName: 'Mission' }), store.create({ ...LEADER, groupName: 'MISSION' })]);
  assert.deepEqual(dupes.map(d => d.status), ['rejected', 'fulfilled', 'rejected']);
  assert.deepEqual(store.preview('Mission'), { available: false, code: 'MISSION2' });
  assert.deepEqual(store.preview('Glen Park'), { available: true, code: 'GLENP' });
  assert.deepEqual(store.preview('Demo'), { available: true, code: 'DEMO2' }); // DEMO is the public sample page
  assert.deepEqual(store.list().map(g => g.groupName), ['Mission', 'Sunset Yellow Apples', 'Sunset Young Adults', 'Sunset Young Artists']);
});

test('maskEmail keeps 3 letters and the real domain', () => {
  assert.equal(maskEmail('maria@gmail.com'), 'mar***@gmail.com');
  assert.equal(maskEmail('al@x.org'), 'al***@x.org');
  assert.equal(maskEmail(''), '');
});
