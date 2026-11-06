/**
 * groups.js
 *
 * Community Groups: a leader creates a group (names are unique) and gets a
 * code made from its name, e.g. "Sunset Young Adults" → SUNSETYA; members join
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

// Longest values accepted from the forms
const MAX_TEXT = 80;
const MAX_EMAIL = 254;

export function normalizeCode(code) {
  return String(code ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function isEmail(s) {
  const e = String(s ?? '').trim();
  return e.length <= MAX_EMAIL && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

/** Two names are the same group if they match ignoring case, spacing and punctuation */
export function nameKey(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Codes no group can take: /cg/DEMO is the public sample page
const RESERVED_CODES = new Set(['DEMO']);

// Words that say "this is a CG" rather than which one, left out of codes
const GENERIC_WORDS = new Set(['CG', 'COMMUNITY', 'GROUP', 'GROUPS']);

/**
 * A short code from the name: the first word (up to 8 letters) plus the
 * first letter of each other word, at most 10 characters.
 * "Sunset Young Adults" → SUNSETYA, "Mission CG" → MISSION
 */
export function codeFromName(name) {
  const words = (String(name ?? '').toUpperCase().match(/[A-Z0-9]+/g) ?? []).filter(w => !GENERIC_WORDS.has(w));
  if (words.length === 0) return 'GROUP';
  return (words[0].slice(0, 8) + words.slice(1).map(w => w[0]).join('')).slice(0, 10);
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

  const nameTaken = name => [...groups.values()].some(g => nameKey(g.groupName) === nameKey(name));

  /** The code a new group with this name gets: its name's code, or with 2, 3… if that's taken */
  function nextCode(groupName) {
    const base = codeFromName(groupName);
    const taken = c => groups.has(c) || RESERVED_CODES.has(c);
    if (!taken(base)) return base;
    for (let n = 2; ; n++) if (!taken(`${base}${n}`)) return `${base}${n}`;
  }

  /** For the start form: is this name free, and what code would it get? */
  function preview(groupName) {
    const name = String(groupName ?? '').trim();
    if (!name) return { available: false, code: '' };
    return { available: !nameTaken(name), code: nextCode(name) };
  }

  async function create({ leaderName, leaderEmail, groupName, neighborhood }) {
    leaderName = String(leaderName ?? '').trim();
    leaderEmail = String(leaderEmail ?? '').trim().toLowerCase();
    groupName = String(groupName ?? '').trim();
    neighborhood = String(neighborhood ?? '').trim();
    if (!leaderName || !groupName) throw userError('Please fill in your name and your CG name.');
    if ([leaderName, groupName, neighborhood].some(v => v.length > MAX_TEXT)) {
      throw userError(`Please keep each answer under ${MAX_TEXT} characters.`);
    }
    if (!isEmail(leaderEmail)) throw userError('Please enter a valid email.');
    if (nameTaken(groupName)) {
      throw userError(`There's already a CG called "${groupName}". Try adding your neighborhood or leader's name.`);
    }

    // Claim the name and code before the (slow) Sheet write, so two groups
    // created at the same moment can't both get them
    const code = nextCode(groupName);
    const row = { code, group_name: groupName, neighborhood, leader_name: leaderName, leader_email: leaderEmail, created_at: new Date().toISOString() };
    addGroup(row);
    try {
      await api.appendRowsRaw(sheetId, GROUPS_TAB, [GROUPS_HEADER.map(h => row[h])]);
    } catch (err) {
      groups.delete(code);
      throw err;
    }
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
    preview,
    /** Every group, by name, for the /cg page */
    list: () => [...groups.values()].sort((a, b) => a.groupName.localeCompare(b.groupName)),
    get: code => groups.get(normalizeCode(code)) ?? null,
    memberKeys: code => new Set(groups.get(normalizeCode(code))?.members.keys() ?? []),
  };
}

/**
 * One entry per member (a join), newest first: their email and every
 * email_key that join added.
 * @returns {{email: string, keys: string[], joinedAt: string}[]}
 */
export function memberList(g) {
  const byRef = new Map();
  for (const [key, m] of g.members) {
    const entry = byRef.get(m.ref) ?? byRef.set(m.ref, { email: m.email, keys: [], joinedAt: m.joinedAt }).get(m.ref);
    entry.keys.push(key);
  }
  return [...byRef.values()].sort((a, b) => b.joinedAt.localeCompare(a.joinedAt));
}

/** What the pages show of a member's email: 3 letters, then the real domain, e.g. "mar***@gmail.com" */
export function maskEmail(email) {
  const e = String(email ?? '');
  const at = e.lastIndexOf('@');
  if (at < 0) return e ? `${e.slice(0, 3)}***` : '';
  return `${e.slice(0, Math.min(3, at))}***${e.slice(at)}`;
}

/** Public view of a group: only what the pages show. */
export function publicGroup(g) {
  return { code: g.code, groupName: g.groupName };
}

function userError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}
