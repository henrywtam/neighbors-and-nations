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
 * @returns {Promise<{updatedRows: number}>}
 */
export async function appendRows(sheetId, tab, rows, credentials = null) {
  if (rows.length === 0) return { updatedRows: 0 };

  const auth = makeAuth(credentials, false);
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: tab,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });

  return { updatedRows: res.data.updates?.updatedRows ?? rows.length };
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

  const auth = makeAuth(credentials, false);
  const sheets = google.sheets({ version: 'v4', auth });

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
  const auth = makeAuth(credentials, true);

  const sheets = google.sheets({ version: 'v4', auth });

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
