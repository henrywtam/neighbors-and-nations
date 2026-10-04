/**
 * sync-from-pc.js
 *
 * Manual CLI wrapper around src/sync-pc.js.
 * For the automated polling loop, see src/index.js.
 *
 * Usage:
 *   node scripts/sync-from-pc.js              # sync new submissions only
 *   node scripts/sync-from-pc.js --dry-run    # print rows without writing
 *   node scripts/sync-from-pc.js --full       # re-sync all (ignores since-date)
 *
 * Note: --dry-run and --full are only supported here; the polling loop always
 * does an incremental sync.
 */

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readSheet, appendRows, writeUnmatched } from '../src/sheets.js';
import { getSubmissionsWithValues } from '../src/planningcenter.js';
import { initGeonames, lookupCityGlobal, countryNameToCode } from '../src/geonames.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Form config — "Neighbors & Nations Discovery Survey" (id=1335453)
// ---------------------------------------------------------------------------

const FORM_ID = process.env.PLANNING_CENTER_FORM_ID ?? '1335453';

// Map: Planning Center field ID → logical role in our data model
const FIELD = {
  // Checkboxes — produce arrays
  VOCATIONS:       '10680003',
  HEARTBEATS:      '10680646',

  // Where they live
  LIVES_AREA:      '10680652',   // San Francisco | East Bay | North Bay | Peninsula | South Bay
  NEIGHBORHOOD_SF: '10680665',   // SF neighborhood dropdown
  CITY_EAST_BAY:   '10680686',
  CITY_PENINSULA:  '10680691',
  CITY_SOUTH_BAY:  '10680695',

  // Place 1  (confirmed via option IDs: 11822977=City, 11822978=Country, 11822979=Region)
  P1_TYPE:    '10680701',  // City | Country | Region
  P1_REGION:  '10680703',  // dropdown (shown when Region): Africa | East & Southeast Asia | …
  P1_CITY:    '10680704',  // text (shown when City): city name typed by user
  P1_COUNTRY: '10680705',  // text (shown when Country): country name typed by user

  // Place 2
  P2_TYPE:    '10680706',
  P2_REGION:  '10680708',  // shown when Region
  P2_CITY:    '10680709',  // shown when City
  P2_COUNTRY: '10680710',  // shown when Country

  // Place 3
  P3_TYPE:    '10680707',
  P3_REGION:  '10680711',  // shown when Region
  P3_CITY:    '10680712',  // shown when City
  P3_COUNTRY: '10680713',  // shown when Country
};

// Ordered Sheets columns (must match row 1 of the Responses tab)
const SHEET_COLUMNS = [
  'person_id',
  'submitted_at',
  'is_test',
  'vocation_1', 'vocation_2', 'vocation_3',
  'heartbeat_1', 'heartbeat_2', 'heartbeat_3',
  'connect_1_place', 'connect_1_city',
  'connect_2_place', 'connect_2_city',
  'connect_3_place', 'connect_3_city',
  'connect_where_i_live',
  'lives_area',
  'lives_place',
];

// ---------------------------------------------------------------------------
// Prefix map: PC "Where Do You Live?" option → lives_place prefix
// (used to construct "SF: Mission", "East Bay: Oakland", etc.)
// ---------------------------------------------------------------------------
const AREA_PREFIX = {
  'San Francisco': 'SF',
  'East Bay':      'East Bay',
  'North Bay':     'North Bay',
  'Peninsula':     'Peninsula',
  'South Bay':     'South Bay',
};

// Which neighborhood/city field to use for each area
const AREA_CITY_FIELD = {
  'San Francisco': FIELD.NEIGHBORHOOD_SF,
  'East Bay':      FIELD.CITY_EAST_BAY,
  'Peninsula':     FIELD.CITY_PENINSULA,
  'South Bay':     FIELD.CITY_SOUTH_BAY,
  // North Bay has no sub-dropdown — only the area label is stored
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FULL_SYNC = args.includes('--full');

async function main() {
  const sheetId = process.env.SHEET_ID;
  if (!sheetId) throw new Error('SHEET_ID not set');

  // -------------------------------------------------------------------------
  // 0. Load geonames (needed to resolve city-only entries to a country)
  // -------------------------------------------------------------------------
  try {
    const citiesPath = join(__dirname, '..', 'data', 'cities15k.json');
    await initGeonames(citiesPath);
  } catch {
    console.warn('[sync] GeoNames unavailable — City-type connections will not have a country resolved.');
  }

  // -------------------------------------------------------------------------
  // 1. Read existing Sheets data to find known person_ids + latest date
  // -------------------------------------------------------------------------
  console.log('[sync] Reading existing Sheets responses…');
  const sheetData = await readSheet(sheetId);
  const existingIds = new Set(
    sheetData.responses.map(r => String(r.person_id ?? '').trim()).filter(Boolean),
  );
  console.log(`[sync] ${existingIds.size} existing person_ids in Sheets.`);

  // -------------------------------------------------------------------------
  // 2. Determine since-date (1h buffer to catch out-of-order submissions)
  // -------------------------------------------------------------------------
  let since = null;
  if (!FULL_SYNC && sheetData.responses.length > 0) {
    const dates = sheetData.responses
      .map(r => r.submitted_at ? new Date(r.submitted_at) : null)
      .filter(Boolean);
    if (dates.length > 0) {
      since = new Date(Math.max(...dates.map(d => d.getTime())) - 60 * 60 * 1000);
      console.log(`[sync] Fetching submissions since ${since.toISOString()}`);
    }
  } else {
    console.log('[sync] Full sync — fetching all submissions.');
  }

  // -------------------------------------------------------------------------
  // 3. Fetch from Planning Center
  // -------------------------------------------------------------------------
  console.log('[sync] Fetching Planning Center submissions…');
  const submissions = await getSubmissionsWithValues(FORM_ID, since);
  console.log(`[sync] ${submissions.length} submission(s) returned from PC.`);

  // -------------------------------------------------------------------------
  // 4. Filter to genuinely new person_ids
  // -------------------------------------------------------------------------
  const newSubmissions = submissions.filter(sub => {
    const pid = String(sub.person_id ?? sub.id ?? '').trim();
    return pid && !existingIds.has(pid);
  });
  console.log(`[sync] ${newSubmissions.length} new submission(s) to write.`);

  if (newSubmissions.length === 0) {
    console.log('[sync] Nothing to do.');
    return;
  }

  // -------------------------------------------------------------------------
  // 5. Map to Sheets rows, collecting unmatched items along the way
  // -------------------------------------------------------------------------
  const unmatchedItems = [];
  const rows = newSubmissions.map(sub => mapToRow(sub, unmatchedItems));

  if (DRY_RUN) {
    console.log('\n[sync] DRY RUN — rows that would be appended:\n');
    for (const row of rows) {
      const obj = Object.fromEntries(SHEET_COLUMNS.map((col, i) => [col, row[i]]));
      console.log(JSON.stringify(obj, null, 2));
    }
    if (unmatchedItems.length > 0) {
      console.log('\n[sync] Unmatched items that would be logged:\n');
      for (const item of unmatchedItems) console.log(' ', JSON.stringify(item));
    }
    return;
  }

  // -------------------------------------------------------------------------
  // 6. Append to Sheets + log unmatched
  // -------------------------------------------------------------------------
  const { updatedRows } = await appendRows(sheetId, 'Responses', rows);
  console.log(`[sync] Wrote ${updatedRows} row(s) to Sheets.`);

  if (unmatchedItems.length > 0) {
    const { added } = await writeUnmatched(sheetId, unmatchedItems);
    if (added > 0) console.log(`[sync] Logged ${added} new unmatched item(s) to Sheets.`);
  }
}

// ---------------------------------------------------------------------------
// Row mapper
// ---------------------------------------------------------------------------

/**
 * Convert a PC submission (values: Map<fieldId, string[]>) to a Sheets row array.
 * Appends any unresolvable countries/cities to unmatchedItems.
 */
function mapToRow(sub, unmatchedItems = []) {
  const v = sub.values; // Map<fieldId, string[]>
  const get = id => v.get(id)?.[0] ?? '';   // first value (single-select)
  const getAll = id => v.get(id) ?? [];     // all values (multi-select)

  const record = {};

  // --- Identity ---
  record['person_id']    = String(sub.person_id ?? sub.id ?? '');
  record['submitted_at'] = sub.created_at ?? '';
  record['is_test']      = (sub.emails ?? []).some(e => e.endsWith('@mac.com')) ? 'TRUE' : 'FALSE';

  // --- Vocations (up to 3) ---
  const vocations = getAll(FIELD.VOCATIONS).slice(0, 3);
  record['vocation_1'] = vocations[0] ?? '';
  record['vocation_2'] = vocations[1] ?? '';
  record['vocation_3'] = vocations[2] ?? '';

  // --- Heartbeats (up to 3) ---
  const heartbeats = getAll(FIELD.HEARTBEATS).slice(0, 3);
  record['heartbeat_1'] = heartbeats[0] ?? '';
  record['heartbeat_2'] = heartbeats[1] ?? '';
  record['heartbeat_3'] = heartbeats[2] ?? '';

  // --- Where they live ---
  const livesArea = get(FIELD.LIVES_AREA);
  const areaPrefix = AREA_PREFIX[livesArea] ?? livesArea;
  const cityFieldId = AREA_CITY_FIELD[livesArea];
  const cityValue = cityFieldId ? get(cityFieldId) : '';

  record['lives_area'] = areaPrefix;
  record['lives_place'] = cityValue ? `${areaPrefix}: ${cityValue}` : areaPrefix;

  // Home is not shown on the map (per form description: "Screens never show where anyone lives")
  record['connect_where_i_live'] = 'FALSE';

  // --- Prayerful connections ---
  const placeDef = [
    { type: FIELD.P1_TYPE, region: FIELD.P1_REGION, country: FIELD.P1_COUNTRY, city: FIELD.P1_CITY, placeCol: 'connect_1_place', cityCol: 'connect_1_city' },
    { type: FIELD.P2_TYPE, region: FIELD.P2_REGION, country: FIELD.P2_COUNTRY, city: FIELD.P2_CITY, placeCol: 'connect_2_place', cityCol: 'connect_2_city' },
    { type: FIELD.P3_TYPE, region: FIELD.P3_REGION, country: FIELD.P3_COUNTRY, city: FIELD.P3_CITY, placeCol: 'connect_3_place', cityCol: 'connect_3_city' },
  ];

  for (const p of placeDef) {
    const placeType = get(p.type);   // 'City' | 'Country' | 'Region' | ''
    let placeValue = '';
    let cityValue = '';

    if (placeType === 'Region') {
      // User picked a world region from the dropdown
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
          placeValue = `City: ${geo.countryName}`;  // special prefix: dot only, no country glow
          cityValue  = typedCity;
        } else {
          unmatchedItems.push({ person_id: sub.person_id, type: 'city', value: typedCity, context: 'global lookup failed' });
          cityValue = typedCity;
        }
      }
    }

    record[p.placeCol] = placeValue;
    record[p.cityCol]  = cityValue;
  }

  return SHEET_COLUMNS.map(col => record[col] ?? '');
}

main().catch(err => {
  console.error('[sync] Fatal:', err.message);
  process.exit(1);
});
