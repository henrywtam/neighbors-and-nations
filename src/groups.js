/**
 * groups.js
 *
 * Community Groups: a leader creates a group and gets a code; members join
 * with the code and the email they used on the survey. The CG insights page
 * then shows results only for responses whose email_key is on that group's
 * roster.
 *
 * Two append-only Sheet tabs, loaded once at startup and kept in memory:
 *   Groups       code, group_name, neighborhood, leader_name, leader_email, created_at
 *   GroupMembers code, email_key, member_ref, joined_at, email
 *
 * email_key (same hash as Responses) links a member to their survey answers;
 * the address is kept so the group's page can list who has joined. The
 * leader's email is kept so Justice & Outreach can follow up.
 *
 * The Sheets API functions are injectable for tests.
 */

import { randomBytes } from 'node:crypto';
import * as sheetsApi from './sheets.js';
import { emailKey } from './sync-pc.js';

export const GROUPS_TAB = 'Groups';
export const MEMBERS_TAB = 'GroupMembers';
const GROUPS_HEADER = ['code', 'group_name', 'neighborhood', 'leader_name', 'leader_email', 'created_at'];
const MEMBERS_HEADER = ['code', 'email_key', 'member_ref', 'joined_at', 'email'];

// Code digits skip 0 and 1, which read like O and I on a screen
const CODE_DIGITS = '23456789';

export function normalizeCode(code) {
  return String(code ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s ?? '').trim());
}

/** e.g. "Sunset Young Adults" → "SUNSET" + 2 digits */
function codeStem(groupName, neighborhood) {
  const word = `${groupName} ${neighborhood}`.toUpperCase().match(/[A-Z]{3,}/)?.[0] ?? 'GROUP';
  return word.slice(0, 6);
}

export function createGroupStore(sheetId, api = sheetsApi) {
  /** @type {Map<string, {code, groupName, neighborhood, leaderName, leaderEmail, createdAt, members: Map<string, {ref, email, joinedAt}>}>} */
  const groups = new Map();

  function addGroup(r) {
    const code = normalizeCode(r.code);
    if (!code || groups.has(code)) return;
    groups.set(code, {
      code,
      groupName: r.group_name ?? '',
      neighborhood: r.neighborhood ?? '',
      leaderName: r.leader_name ?? '',
      leaderEmail: r.leader_email ?? '',
      createdAt: r.created_at ?? '',
      members: new Map(), // email_key → {ref, email, joinedAt}; one ref per join, so a second email isn't a second person
    });
  }

  function addMember(r) {
    const g = groups.get(normalizeCode(r.code));
    const key = String(r.email_key ?? '').trim();
    if (g && key && !g.members.has(key)) {
      g.members.set(key, { ref: r.member_ref || key, email: r.email ?? '', joinedAt: r.joined_at ?? '' });
    }
  }

  async function init() {
    const [g, m] = await Promise.all([
      api.readOrCreateTab(sheetId, GROUPS_TAB, GROUPS_HEADER),
      api.readOrCreateTab(sheetId, MEMBERS_TAB, MEMBERS_HEADER),
    ]);
    groups.clear();
    api.rowsToObjects(g.header, g.rows).forEach(addGroup);
    api.rowsToObjects(m.header, m.rows).forEach(addMember);
  }

  function newCode(groupName, neighborhood) {
    const stem = codeStem(groupName, neighborhood);
    for (let i = 0; i < 50; i++) {
      const n = randomBytes(2);
      const code = stem + CODE_DIGITS[n[0] % 8] + CODE_DIGITS[n[1] % 8];
      if (!groups.has(code)) return code;
    }
    return stem + randomBytes(3).toString('hex').toUpperCase();
  }

  async function create({ leaderName, leaderEmail, groupName, neighborhood }) {
    leaderName = String(leaderName ?? '').trim();
    leaderEmail = String(leaderEmail ?? '').trim().toLowerCase();
    groupName = String(groupName ?? '').trim();
    neighborhood = String(neighborhood ?? '').trim();
    if (!leaderName || !groupName || !neighborhood) throw userError('Please fill in every field.');
    if (!isEmail(leaderEmail)) throw userError('Please enter a valid email.');

    const code = newCode(groupName, neighborhood);
    const row = { code, group_name: groupName, neighborhood, leader_name: leaderName, leader_email: leaderEmail, created_at: new Date().toISOString() };
    await api.appendRowsRaw(sheetId, GROUPS_TAB, [GROUPS_HEADER.map(h => row[h])]);
    addGroup(row);
    // The leader is a member too
    await join(code, [leaderEmail]);
    return groups.get(code);
  }

  /** @returns {Promise<{group, added: number}>} */
  async function join(code, emails) {
    const g = groups.get(normalizeCode(code));
    if (!g) throw userError("We couldn't find that group code. Check it and try again.");
    const valid = emails.map(e => String(e ?? '').trim()).filter(Boolean);
    if (valid.length === 0 || !valid.every(isEmail)) throw userError('Please enter a valid email.');

    const ref = randomBytes(6).toString('hex');
    const now = new Date().toISOString();
    const byKey = new Map(valid.map(e => [emailKey(e), e.toLowerCase()]));
    const rows = [...byKey]
      .filter(([k]) => !g.members.has(k))
      .map(([k, email]) => ({ code: g.code, email_key: k, member_ref: ref, joined_at: now, email }));
    await api.appendRowsRaw(sheetId, MEMBERS_TAB, rows.map(r => MEMBERS_HEADER.map(h => r[h])));
    rows.forEach(addMember);
    return { group: g, added: rows.length };
  }

  return {
    init,
    create,
    join,
    get: code => groups.get(normalizeCode(code)) ?? null,
    memberKeys: code => new Set(groups.get(normalizeCode(code))?.members.keys() ?? []),
  };
}

/**
 * One entry per member (a join), newest first: their email and every
 * email_key that join added.
 * @returns {{email: string, keys: string[], joinedAt: string}[]}
 */
function memberList(g) {
  const byRef = new Map();
  for (const [key, m] of g.members) {
    const entry = byRef.get(m.ref) ?? byRef.set(m.ref, { email: m.email, keys: [], joinedAt: m.joinedAt }).get(m.ref);
    entry.keys.push(key);
  }
  return [...byRef.values()].sort((a, b) => b.joinedAt.localeCompare(a.joinedAt));
}

export { memberList };

/** Public view of a group: no emails, no member keys. */
export function publicGroup(g) {
  return {
    code: g.code,
    groupName: g.groupName,
    neighborhood: g.neighborhood,
    leaderName: g.leaderName,
    memberCount: new Set([...g.members.values()].map(m => m.ref)).size,
  };
}

function userError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}
