/**
 * sheet-cache.js
 *
 * In-memory cache of the Google Sheet, kept current with as few requests as
 * possible:
 *
 *   - init():            one full read of Responses + reference tabs (startup only)
 *   - checkForUpdates(): reads Meta!A2:B5; if row_count grew, fetches only the
 *                        new rows past the cached count
 *   - refreshReference(): re-reads the small Lists/Regions/Approvals tabs
 *
 * Also tracks every submission key already in the Sheet, so the Planning
 * Center sync can skip duplicates without re-reading Responses.
 *
 * The Sheets API functions are injectable for tests.
 */

import * as sheetsApi from './sheets.js';

export const SUBMISSION_ID_COL = 'submission_id';
export const EMAIL_KEY_COL = 'email_key';
// Columns added after launch; header cells are written on startup if missing
const ADDED_COLS = [SUBMISSION_ID_COL, EMAIL_KEY_COL];

/** Dedup key for rows written before submission_id existed. */
export function legacyKey(personId, submittedAt) {
  return `${String(personId ?? '').trim()}|${String(submittedAt ?? '').trim()}`;
}

export function createSheetCache(sheetId, api = sheetsApi) {
  let header = [];
  let responses = [];          // row objects keyed by header
  let rowCount = 0;            // data rows cached (excludes header)
  let meta = null;
  let reference = { lists: {}, regionMap: new Map(), approvals: new Map(), raw: '' };
  const submissionIds = new Set();
  const legacyKeys = new Set();

  function index(rows) {
    for (const r of rows) {
      const sid = String(r[SUBMISSION_ID_COL] ?? '').trim();
      if (sid) submissionIds.add(sid);
      legacyKeys.add(legacyKey(r.person_id, r.submitted_at));
    }
  }

  function addRows(rawRows) {
    const objs = api.rowsToObjects(header, rawRows);
    responses.push(...objs);
    rowCount += rawRows.length;
    index(objs);
  }

  let readOnly = false;

  async function loadResponses() {
    const full = await api.readResponsesFull(sheetId);
    header = full.header;
    responses = [];
    rowCount = 0;
    submissionIds.clear();
    legacyKeys.clear();

    // Add new columns once (header cells only — data rows untouched)
    for (const col of ADDED_COLS) {
      if (header.length > 0 && !header.includes(col)) {
        if (!readOnly) await api.writeHeaderCell(sheetId, header.length, col);
        header = [...header, col];
      }
    }

    addRows(full.rows);
  }

  /** Build Meta from cached rows (bootstrap, or after rows were edited by hand). */
  function metaFromCache() {
    let lastSyncedAt = '';
    let lastSubmissionId = '';
    for (const r of responses) {
      const t = String(r.submitted_at ?? '');
      if (t && (!lastSyncedAt || Date.parse(t) > Date.parse(lastSyncedAt))) lastSyncedAt = t;
      const sid = String(r[SUBMISSION_ID_COL] ?? '').trim();
      if (sid) lastSubmissionId = sid;
    }
    return {
      last_synced_at: meta?.last_synced_at || lastSyncedAt,
      last_submission_id: meta?.last_submission_id || lastSubmissionId,
      row_count: rowCount,
      last_updated: new Date().toISOString(),
    };
  }

  return {
    /**
     * Startup: full read once, then make sure Meta matches reality.
     * @param {{readOnly?: boolean}} [opts] readOnly skips the header/Meta fix-ups (dry runs)
     */
    async init(opts = {}) {
      readOnly = !!opts.readOnly;
      const [, ref, m] = await Promise.all([
        loadResponses(),
        api.readReferenceTabs(sheetId),
        api.readMeta(sheetId),
      ]);
      reference = ref;
      meta = m;
      if (!meta || meta.row_count !== rowCount) {
        meta = metaFromCache();
        if (!readOnly) await api.writeMeta(sheetId, meta);
      }
    },

    /**
     * Read Meta; fetch only new rows if it changed.
     * @returns {Promise<boolean>} true if new rows were added to the cache
     */
    async checkForUpdates() {
      const m = await api.readMeta(sheetId);
      if (!m) throw new Error('Meta tab missing');
      const unchanged = meta && m.row_count === meta.row_count && m.last_updated === meta.last_updated;
      if (unchanged) return false;

      let changed = false;
      if (m.row_count > rowCount) {
        // Data rows live at sheet rows 2..row_count+1
        const rows = await api.readResponseRows(sheetId, rowCount + 2, m.row_count + 1);
        addRows(rows);
        changed = rows.length > 0;
      } else if (m.row_count < rowCount) {
        // Rows were removed by hand — rare; resync from scratch
        await loadResponses();
        changed = true;
      }
      meta = m;
      return changed;
    },

    /** Re-read the small reference tabs. @returns {Promise<boolean>} true if contents changed */
    async refreshReference() {
      const ref = await api.readReferenceTabs(sheetId);
      if (ref.raw === reference.raw) return false;
      reference = ref;
      return true;
    },

    /** True if this submission is already in the Sheet. */
    has({ submissionId, personId, submittedAt }) {
      return (submissionId && submissionIds.has(String(submissionId)))
        || legacyKeys.has(legacyKey(personId, submittedAt));
    },

    get meta() { return meta; },
    get rowCount() { return rowCount; },
    get header() { return header; },

    /** SheetData shape expected by processResponses(). */
    sheetData() {
      return {
        responses,
        lists: reference.lists,
        regionMap: reference.regionMap,
        approvals: reference.approvals,
        readAt: new Date(),
      };
    },
  };
}
