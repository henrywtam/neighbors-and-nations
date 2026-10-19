/**
 * sync-pc.js
 *
 * Callable module: syncs new Planning Center form submissions into the
 * Google Sheets "Responses" tab. Triggered by the Planning Center webhook
 * (or the fallback poll) in index.js.
 *
 * Append-only: existing rows are never cleared or rewritten. Only writes to
 * the Sheet when there is at least one new submission, then updates Meta.
 *
 * The standalone script at scripts/sync-from-pc.js is kept for manual use
 * but delegates to this module.
 */

import { createHash } from 'node:crypto';
import { appendRows, writeUnmatched, writeMeta } from './sheets.js';
import { getFormSubmissions, getSubmissionDetails } from './planningcenter.js';
import { lookupCityGlobal, countryNameToCode } from './geonames.js';
import { normalizeCountryName } from './processor.js';

// ---------------------------------------------------------------------------
// Form config
// ---------------------------------------------------------------------------

const FORM_ID = process.env.PLANNING_CENTER_FORM_ID ?? '1335453';

const FIELD = {
  VOCATIONS:       '10680003',
  HEARTBEATS:      '10680646',
  LIVES_AREA:      '10680652',
  NEIGHBORHOOD_SF: '10680665',
  CITY_EAST_BAY:   '10680686',
  CITY_PENINSULA:  '10680691',
  CITY_SOUTH_BAY:  '10680695',
  P1_TYPE:    '10680701', P1_REGION: '10680703', P1_CITY: '10680704', P1_COUNTRY: '10680705',
  P2_TYPE:    '10680706', P2_REGION: '10680708', P2_CITY: '10680709', P2_COUNTRY: '10680710',
  P3_TYPE:    '10680707', P3_REGION: '10680711', P3_CITY: '10680712', P3_COUNTRY: '10680713',
};

const AREA_PREFIX = {
  'San Francisco': 'SF',
  'East Bay':      'East Bay',
  'North Bay':     'North Bay',
  'Peninsula':     'Peninsula',
  'South Bay':     'South Bay',
};

const AREA_CITY_FIELD = {
  'San Francisco': FIELD.NEIGHBORHOOD_SF,
  'East Bay':      FIELD.CITY_EAST_BAY,
  'Peninsula':     FIELD.CITY_PENINSULA,
  'South Bay':     FIELD.CITY_SOUTH_BAY,
};

export const SHEET_COLUMNS = [
  'person_id', 'submitted_at', 'is_test',
  'vocation_1', 'vocation_2', 'vocation_3',
  'heartbeat_1', 'heartbeat_2', 'heartbeat_3',
  'connect_1_place', 'connect_1_city',
  'connect_2_place', 'connect_2_city',
  'connect_3_place', 'connect_3_city',
  'connect_where_i_live',
  'lives_area', 'lives_place',
  'submission_id',
  'email_key',
  'vocation_extra', 'heartbeat_extra',
];

// Picks beyond the first 3 go into one *_extra cell, joined with this
export const EXTRA_SEPARATOR = ' | ';

/**
 * Stable, non-reversible-at-a-glance key for an email address, so the Sheet
 * can group a person's submissions without storing the address itself.
 * SHA-256 of the trimmed, lowercased address, first 16 hex chars.
 */
export function emailKey(email) {
  const norm = String(email ?? '').trim().toLowerCase();
  if (!norm) return '';
  return createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Row mapper (identical logic to scripts/sync-from-pc.js)
// ---------------------------------------------------------------------------

export function mapToRow(sub, unmatchedItems = [], columns = SHEET_COLUMNS) {
  const v = sub.values;
  const get = id => v.get(id)?.[0] ?? '';
  const getAll = id => v.get(id) ?? [];
  const record = {};

  record['person_id']    = String(sub.person_id ?? sub.id ?? '');
  record['submitted_at'] = sub.created_at ?? '';
  record['submission_id'] = String(sub.id ?? '');
  record['email_key']     = emailKey(sub.emails?.[0]);  // primary email
  record['is_test']      = (sub.emails ?? []).some(e => e.endsWith('@mac.com')) ? 'TRUE' : 'FALSE';

  // No cap: the form asks for 3, but every box checked is kept
  const vocations = getAll(FIELD.VOCATIONS);
  record['vocation_1'] = vocations[0] ?? '';
  record['vocation_2'] = vocations[1] ?? '';
  record['vocation_3'] = vocations[2] ?? '';
  record['vocation_extra'] = vocations.slice(3).join(EXTRA_SEPARATOR);

  const heartbeats = getAll(FIELD.HEARTBEATS);
  record['heartbeat_1'] = heartbeats[0] ?? '';
  record['heartbeat_2'] = heartbeats[1] ?? '';
  record['heartbeat_3'] = heartbeats[2] ?? '';
  record['heartbeat_extra'] = heartbeats.slice(3).join(EXTRA_SEPARATOR);

  const livesArea = get(FIELD.LIVES_AREA);
  const areaPrefix = AREA_PREFIX[livesArea] ?? livesArea;
  const cityFieldId = AREA_CITY_FIELD[livesArea];
  const cityVal = cityFieldId ? get(cityFieldId) : '';
  record['lives_area']  = areaPrefix;
  record['lives_place'] = cityVal ? `${areaPrefix}: ${cityVal}` : areaPrefix;
  record['connect_where_i_live'] = 'FALSE';

  const placeDefs = [
    { type: FIELD.P1_TYPE, region: FIELD.P1_REGION, country: FIELD.P1_COUNTRY, city: FIELD.P1_CITY, placeCol: 'connect_1_place', cityCol: 'connect_1_city' },
    { type: FIELD.P2_TYPE, region: FIELD.P2_REGION, country: FIELD.P2_COUNTRY, city: FIELD.P2_CITY, placeCol: 'connect_2_place', cityCol: 'connect_2_city' },
    { type: FIELD.P3_TYPE, region: FIELD.P3_REGION, country: FIELD.P3_COUNTRY, city: FIELD.P3_CITY, placeCol: 'connect_3_place', cityCol: 'connect_3_city' },
  ];

  for (const p of placeDefs) {
    const placeType = get(p.type);
    let placeValue = '';
    let placeCityValue = '';

    if (placeType === 'Region') {
      const regionName = get(p.region);
      placeValue = regionName ? `Region: ${regionName}` : '';
    } else if (placeType === 'Country') {
      const typedCountry = get(p.country);
      if (typedCountry) {
        const countryName = normalizeCountryName(typedCountry, countryNameToCode);
        if (countryNameToCode[countryName]) {
          placeValue = countryName;
        } else {
          unmatchedItems.push({ person_id: sub.person_id, type: 'country', value: typedCountry, context: '' });
        }
      }
    } else if (placeType === 'City') {
      const typedCity = get(p.city);
      if (typedCity) {
        const geo = lookupCityGlobal(typedCity);
        if (geo?.countryName) {
          placeValue = `City: ${geo.countryName}`;
          placeCityValue = typedCity;
        } else {
          unmatchedItems.push({ person_id: sub.person_id, type: 'city', value: typedCity, context: 'global lookup failed' });
          placeCityValue = typedCity;
        }
      }
    }

    record[p.placeCol] = placeValue;
    record[p.cityCol]  = placeCityValue;
  }

  return columns.map(col => record[col] ?? '');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Re-list this far back before last_synced_at to catch submissions that land
// slightly out of order. Listing is one request; known IDs are skipped before
// any per-submission detail requests.
const LOOKBACK_MS = 60 * 60 * 1000;

/**
 * Pull new Planning Center submissions and append them to Sheets.
 *
 * @param {string} sheetId
 * @param {ReturnType<import('./sheet-cache.js').createSheetCache>} cache
 *   Initialised sheet cache — provides known submission keys and Meta.
 * @param {{full?: boolean, dryRun?: boolean}} [opts]
 *   full: ignore last_synced_at and list every submission (still deduped).
 *   dryRun: return the rows that would be written without writing anything.
 * @returns {Promise<{newCount: number, unmatchedCount: number, rows?: string[][], unmatchedItems?: object[]}>}
 */
export async function syncPlanningCenter(sheetId, cache, { full = false, dryRun = false } = {}) {
  const meta = cache.meta;
  const since = !full && meta?.last_synced_at
    ? new Date(Date.parse(meta.last_synced_at) - LOOKBACK_MS)
    : null;

  const listed = await getFormSubmissions(FORM_ID, since);
  const fresh = listed.filter(sub => !cache.has({
    submissionId: sub.id,
    personId: sub.person_id ?? sub.id,
    submittedAt: sub.created_at,
  }));

  if (fresh.length === 0) {
    return { newCount: 0, unmatchedCount: 0 };
  }

  fresh.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const newSubmissions = await getSubmissionDetails(fresh);

  const unmatchedItems = [];
  const columns = cache.header.length ? cache.header : SHEET_COLUMNS;
  const rows = newSubmissions.map(sub => mapToRow(sub, unmatchedItems, columns));

  if (dryRun) {
    return { newCount: rows.length, unmatchedCount: unmatchedItems.length, rows, unmatchedItems };
  }

  const { lastRow } = await appendRows(sheetId, 'Responses', rows);

  const latest = newSubmissions[newSubmissions.length - 1];
  const prevSynced = meta?.last_synced_at ? Date.parse(meta.last_synced_at) : 0;
  await writeMeta(sheetId, {
    last_synced_at: Date.parse(latest.created_at) > prevSynced ? latest.created_at : meta.last_synced_at,
    last_submission_id: latest.id,
    // lastRow is the sheet row of the final appended row; row 1 is the header
    row_count: lastRow ? lastRow - 1 : (meta?.row_count ?? 0) + rows.length,
    last_updated: new Date().toISOString(),
  });

  if (unmatchedItems.length > 0) {
    await writeUnmatched(sheetId, unmatchedItems);
  }

  return { newCount: newSubmissions.length, unmatchedCount: unmatchedItems.length };
}
