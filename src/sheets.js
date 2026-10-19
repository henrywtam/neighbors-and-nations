import { google } from 'googleapis';

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

function makeAuth(credentials, readonly = true) {
  const creds = credentials ?? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: readonly
      ? ['https://www.googleapis.com/auth/spreadsheets.readonly']
      : ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

// One client per (credentials, scope) so the OAuth token is reused across
// calls instead of being re-minted on every request.
const clientCache = new Map();

function client(credentials, readonly) {
  const key = `${readonly}|${credentials ? JSON.stringify(credentials) : 'env'}`;
  if (!clientCache.has(key)) {
    clientCache.set(key, google.sheets({ version: 'v4', auth: makeAuth(credentials, readonly) }));
  }
  return clientCache.get(key);
}

// ---------------------------------------------------------------------------
// appendRows
// ---------------------------------------------------------------------------

/**
 * Append rows to a sheet tab.
 *
 * @param {string} sheetId - Spreadsheet ID
 * @param {string} tab - Sheet tab name (e.g. 'Responses')
 * @param {string[][]} rows - Array of row arrays (values only, no headers)
 * @param {object|null} credentials - Service account credentials object.
 *   If null, parsed from GOOGLE_SERVICE_ACCOUNT_JSON env var.
 * @returns {Promise<{updatedRows: number, lastRow: number|null}>}
 *   lastRow is the 1-based sheet row of the last appended row (from updatedRange).
 */
export async function appendRows(sheetId, tab, rows, credentials = null) {
  if (rows.length === 0) return { updatedRows: 0 };

  const sheets = client(credentials, false);

  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: tab,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });

  const range = res.data.updates?.updatedRange ?? '';
  const m = range.match(/(\d+)$/);
  return {
    updatedRows: res.data.updates?.updatedRows ?? rows.length,
    lastRow: m ? parseInt(m[1]) : null,
  };
}

// ---------------------------------------------------------------------------
// writeUnmatched
// ---------------------------------------------------------------------------

/**
 * Append new unmatched countries/cities to the Unmatched tab, skipping any
 * already present (deduped by person_id+type+value).
 *
 * @param {string} sheetId
 * @param {Array<{person_id: string, type: 'country'|'city', value: string, context: string}>} items
 * @param {object|null} credentials
 * @returns {Promise<{added: number}>}
 */
export async function writeUnmatched(sheetId, items, credentials = null) {
  if (items.length === 0) return { added: 0 };

  const sheets = client(credentials, false);

  // Read existing entries to avoid duplicates
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Unmatched',
  }).catch(() => ({ data: { values: [] } }));

  const existingKeys = new Set(
    (existing.data.values ?? []).slice(1).map(r => `${r[0]}|${r[1]}|${r[2]}`)
  );

  const today = new Date().toISOString().slice(0, 10);
  const newRows = items
    .filter(item => !existingKeys.has(`${item.person_id}|${item.type}|${item.value}`))
    .map(item => [item.person_id ?? '', item.type, item.value, item.context ?? '', today]);

  if (newRows.length === 0) return { added: 0 };

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Unmatched',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: newRows },
  });

  return { added: newRows.length };
}

// ---------------------------------------------------------------------------
// readSheet
// ---------------------------------------------------------------------------

/**
 * Read all data from the survey Google Spreadsheet.
 *
 * @param {string} sheetId - Spreadsheet ID
 * @param {object|null} credentials - Service account credentials object.
 *   If null, parsed from GOOGLE_SERVICE_ACCOUNT_JSON env var.
 * @returns {Promise<SheetData>}
 */
export async function readSheet(sheetId, credentials = null) {
  const sheets = client(credentials, true);

  const delays = [500, 1000, 2000];
  let lastError;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise(res => setTimeout(res, delays[attempt - 1]));
      }

      const [responsesRes, listsRes, regionsRes, approvalsRes] =
        await Promise.all([
          sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Responses' }),
          sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Lists' }),
          sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Regions' }),
          sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Approvals' })
            .catch(() => ({ data: { values: [] } })),
        ]);

      const responses = parseRowsWithHeaders(responsesRes.data.values ?? []);
      const lists = parseLists(listsRes.data.values ?? []);
      const regionMap = parseRegionMap(regionsRes.data.values ?? []);
      const approvals = parseApprovals(approvalsRes.data.values ?? []);

      return { responses, lists, regionMap, approvals, readAt: new Date() };
    } catch (err) {
      lastError = err;
      if (attempt < delays.length) {
        console.warn(`[sheets] Read attempt ${attempt + 1} failed: ${err.message}. Retrying...`);
      }
    }
  }

  const structured = new Error(`Sheet read failed after ${delays.length + 1} attempts: ${lastError?.message}`);
  structured.cause = lastError;
  structured.code = 'SHEET_READ_FAILED';
  throw structured;
}

// ---------------------------------------------------------------------------
// Incremental reads/writes (used by the server's sheet cache)
// ---------------------------------------------------------------------------

export const META_TAB = 'Meta';
const META_KEYS = ['last_synced_at', 'last_submission_id', 'row_count', 'last_updated'];

async function withRetry(label, fn) {
  const delays = [500, 1000, 2000];
  let lastError;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      if (attempt > 0) await new Promise(res => setTimeout(res, delays[attempt - 1]));
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < delays.length) {
        console.warn(`[sheets] ${label} attempt ${attempt + 1} failed: ${err.message}. Retrying...`);
      }
    }
  }
  const structured = new Error(`${label} failed after ${delays.length + 1} attempts: ${lastError?.message}`);
  structured.cause = lastError;
  structured.code = 'SHEET_READ_FAILED';
  throw structured;
}

/**
 * Read the Meta tab (key/value rows). Returns null if the tab doesn't exist.
 * Single small request: Meta!A2:B5.
 *
 * @returns {Promise<{last_synced_at: string, last_submission_id: string, row_count: number, last_updated: string}|null>}
 */
export async function readMeta(sheetId, credentials = null) {
  const sheets = client(credentials, true);
  let res;
  try {
    res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${META_TAB}!A2:B${META_KEYS.length + 1}`,
    });
  } catch (err) {
    if (/Unable to parse range/i.test(err.message)) return null;
    throw err;
  }
  const kv = Object.fromEntries((res.data.values ?? []).map(r => [r[0], r[1] ?? '']));
  return {
    last_synced_at: kv.last_synced_at ?? '',
    last_submission_id: kv.last_submission_id ?? '',
    row_count: parseInt(kv.row_count ?? '0') || 0,
    last_updated: kv.last_updated ?? '',
  };
}

/**
 * Overwrite the (tiny, fixed-size) Meta tab. Creates the tab if missing.
 */
export async function writeMeta(sheetId, meta, credentials = null) {
  const sheets = client(credentials, false);
  const values = [['key', 'value'], ...META_KEYS.map(k => [k, String(meta[k] ?? '')])];
  const write = () => sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${META_TAB}!A1:B${values.length}`,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
  try {
    await write();
  } catch (err) {
    if (!/Unable to parse range/i.test(err.message)) throw err;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: META_TAB } } }] },
    });
    await write();
  }
}

/**
 * Read the whole Responses tab once (startup only).
 * @returns {Promise<{header: string[], rows: string[][]}>}
 */
export async function readResponsesFull(sheetId, credentials = null) {
  const sheets = client(credentials, true);
  return withRetry('Responses read', async () => {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Responses' });
    const [header = [], ...rows] = res.data.values ?? [];
    return { header, rows };
  });
}

/**
 * Read only data rows [fromRow, toRow] (1-based sheet rows, inclusive).
 * @returns {Promise<string[][]>}
 */
export async function readResponseRows(sheetId, fromRow, toRow, credentials = null) {
  if (toRow < fromRow) return [];
  const sheets = client(credentials, true);
  return withRetry('Responses incremental read', async () => {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `Responses!A${fromRow}:ZZ${toRow}`,
    });
    return res.data.values ?? [];
  });
}

/**
 * Write a single header cell (used to add the submission_id column once).
 */
export async function writeHeaderCell(sheetId, colIndex, name, credentials = null) {
  const sheets = client(credentials, false);
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `Responses!${columnLetter(colIndex)}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [[name]] },
  });
}

/**
 * Read the small reference tabs (Lists, Regions, Approvals) in one batchGet.
 * @returns {Promise<{lists: object, regionMap: Map, approvals: Map, raw: string}>}
 */
export async function readReferenceTabs(sheetId, credentials = null) {
  const sheets = client(credentials, true);
  return withRetry('Reference tabs read', async () => {
    const res = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: sheetId,
      ranges: ['Lists', 'Regions', 'Approvals'],
    });
    const [lists = [], regions = [], approvals = []] =
      (res.data.valueRanges ?? []).map(vr => vr.values ?? []);
    return {
      lists: parseLists(lists),
      regionMap: parseRegionMap(regions),
      approvals: parseApprovals(approvals),
      raw: JSON.stringify([lists, regions, approvals]),
    };
  });
}

/** Convert a 2D array of data rows into objects keyed by header. */
export function rowsToObjects(header, rows) {
  return rows.map(row => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = row[i] ?? ''; });
    return obj;
  });
}

function columnLetter(index) {
  let s = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/**
 * Convert a 2D array (first row = headers) into array of plain objects.
 */
function parseRowsWithHeaders(values) {
  if (!values || values.length < 1) return [];
  const [headers, ...rows] = values;
  return rows.map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = row[i] ?? '';
    });
    return obj;
  });
}

/**
 * Parse the Lists tab.
 * Column A contains the list name header; subsequent rows in that column are values.
 * Multiple lists may live in separate columns.
 *
 * Layout:
 *   Row 1: vocations | heartbeats | sfNeighborhoods | ...  (headers)
 *   Row 2+: val      | val        | val             | ...
 */
function parseLists(values) {
  if (!values || values.length < 1) return {};

  const result = {};
  const headers = values[0];

  headers.forEach((header, colIdx) => {
    if (!header) return;
    const key = header.trim();
    result[key] = [];
    for (let row = 1; row < values.length; row++) {
      const cell = (values[row]?.[colIdx] ?? '').trim();
      if (cell) result[key].push(cell);
    }
  });

  return result;
}

/**
 * Parse Regions tab: first column = country name, second column = region name.
 * Returns Map<countryName, regionName>.
 */
function parseRegionMap(values) {
  const map = new Map();
  if (!values || values.length < 2) return map;
  // Skip header row
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const country = (row?.[0] ?? '').trim();
    const region = (row?.[1] ?? '').trim();
    if (country) map.set(country, region || null);
  }
  return map;
}


/**
 * Parse Approvals tab.
 * Columns: write_in_text, approved (TRUE/FALSE), show_as
 * Returns Map<write_in_text_lowercase, {approved: bool, showAs: string|null}>
 */
function parseApprovals(values) {
  const map = new Map();
  if (!values || values.length < 2) return map;
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const text = (row?.[0] ?? '').trim();
    const approved = (row?.[1] ?? '').trim().toUpperCase() === 'TRUE';
    const showAs = (row?.[2] ?? '').trim() || null;
    if (text) {
      map.set(text.toLowerCase(), { approved, showAs });
    }
  }
  return map;
}
