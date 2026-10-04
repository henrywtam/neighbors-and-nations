/**
 * sync-pc.js
 *
 * Callable module: syncs new Planning Center form submissions into the
 * Google Sheets "Responses" tab. Called by the polling loop in index.js.
 *
 * The standalone script at scripts/sync-from-pc.js is kept for manual use
 * but delegates to this module.
 */

import { readSheet, appendRows, writeUnmatched } from './sheets.js';
import { getSubmissionsWithValues } from './planningcenter.js';
import { lookupCityGlobal, countryNameToCode } from './geonames.js';

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

const SHEET_COLUMNS = [
  'person_id', 'submitted_at', 'is_test',
  'vocation_1', 'vocation_2', 'vocation_3',
  'heartbeat_1', 'heartbeat_2', 'heartbeat_3',
  'connect_1_place', 'connect_1_city',
  'connect_2_place', 'connect_2_city',
  'connect_3_place', 'connect_3_city',
  'connect_where_i_live',
  'lives_area', 'lives_place',
];

// ---------------------------------------------------------------------------
// Row mapper (identical logic to scripts/sync-from-pc.js)
// ---------------------------------------------------------------------------

function mapToRow(sub, unmatchedItems = []) {
  const v = sub.values;
  const get = id => v.get(id)?.[0] ?? '';
  const getAll = id => v.get(id) ?? [];
  const record = {};

  record['person_id']    = String(sub.person_id ?? sub.id ?? '');
  record['submitted_at'] = sub.created_at ?? '';
  record['is_test']      = (sub.emails ?? []).some(e => e.endsWith('@mac.com')) ? 'TRUE' : 'FALSE';

  const vocations = getAll(FIELD.VOCATIONS).slice(0, 3);
  record['vocation_1'] = vocations[0] ?? '';
  record['vocation_2'] = vocations[1] ?? '';
  record['vocation_3'] = vocations[2] ?? '';

  const heartbeats = getAll(FIELD.HEARTBEATS).slice(0, 3);
  record['heartbeat_1'] = heartbeats[0] ?? '';
  record['heartbeat_2'] = heartbeats[1] ?? '';
  record['heartbeat_3'] = heartbeats[2] ?? '';

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
        if (countryNameToCode[typedCountry]) {
          placeValue = typedCountry;
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

  return SHEET_COLUMNS.map(col => record[col] ?? '');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pull new Planning Center submissions and append them to Sheets.
 *
 * @param {string} sheetId
 * @returns {Promise<{newCount: number, unmatchedCount: number}>}
 */
export async function syncPlanningCenter(sheetId) {
  const sheetData = await readSheet(sheetId);
  const existingIds = new Set(
    sheetData.responses.map(r => String(r.person_id ?? '').trim()).filter(Boolean),
  );

  // Look back 1h from the most-recent submission to catch stragglers
  let since = null;
  if (sheetData.responses.length > 0) {
    const dates = sheetData.responses
      .map(r => r.submitted_at ? new Date(r.submitted_at) : null)
      .filter(Boolean);
    if (dates.length > 0) {
      since = new Date(Math.max(...dates.map(d => d.getTime())) - 60 * 60 * 1000);
    }
  }

  const submissions = await getSubmissionsWithValues(FORM_ID, since);
  const newSubmissions = submissions.filter(sub => {
    const pid = String(sub.person_id ?? sub.id ?? '').trim();
    return pid && !existingIds.has(pid);
  });

  if (newSubmissions.length === 0) {
    return { newCount: 0, unmatchedCount: 0 };
  }

  const unmatchedItems = [];
  const rows = newSubmissions.map(sub => mapToRow(sub, unmatchedItems));

  await appendRows(sheetId, 'Responses', rows);
  if (unmatchedItems.length > 0) {
    await writeUnmatched(sheetId, unmatchedItems);
  }

  return { newCount: newSubmissions.length, unmatchedCount: unmatchedItems.length };
}
