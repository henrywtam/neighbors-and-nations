import 'dotenv/config';
import { google } from 'googleapis';

// ---------------------------------------------------------------------------
// Value pools
// ---------------------------------------------------------------------------

const VOCATIONS = [
  'Student', 'Teacher/Educator', 'Healthcare', 'Business/Entrepreneur',
  'Tech/Engineering', 'Arts/Creative', 'Ministry/Church Work',
  'Government/Public Service', 'Homemaker', 'Retired', 'Other',
];

const HEARTBEATS = [
  'Poverty & Economic Justice', 'Human Trafficking', 'Refugees & Displacement',
  'Education Access', 'Healthcare Access', 'Environmental Stewardship',
  'Racial Justice', 'Religious Freedom', 'Unreached Peoples',
  'Urban Ministry', 'Children & Youth', 'Other',
];

const SF_NEIGHBORHOODS = [
  'Mission', 'Sunset', 'Richmond', 'SOMA', 'Castro', 'Haight',
  'Noe Valley', 'Bernal Heights', 'Bayview', 'Excelsior', 'Marina', 'Pacific Heights',
];

const BAY_AREA_CITIES = [
  'Oakland', 'Berkeley', 'Fremont', 'San Jose', 'Palo Alto',
  'Marin', 'San Rafael', 'Daly City',
];

const BAY_AREA_PREFIXES = ['East Bay', 'North Bay', 'South Bay', 'Peninsula'];

const COUNTRIES = [
  'Thailand', 'Kenya', 'Philippines', 'Nicaragua', 'Uganda',
  'Brazil', 'India', 'Japan', 'Germany', 'Colombia',
  'South Korea', 'Indonesia', 'Ethiopia', 'Egypt', 'Nigeria',
];

const COUNTRY_CITIES = {
  Thailand: ['Bangkok', 'Chiang Mai', 'Phuket'],
  Kenya: ['Nairobi', 'Mombasa'],
  Philippines: ['Manila', 'Cebu'],
  Nicaragua: ['Managua'],
  Uganda: ['Kampala', 'Jinja'],
  Brazil: ['São Paulo', 'Rio de Janeiro'],
  India: ['Mumbai', 'Delhi'],
  Japan: ['Tokyo'],
  Germany: ['Berlin'],
  Colombia: ['Bogotá'],
};

const REGIONS = [
  'Middle East', 'Africa', 'Southeast Asia', 'Latin America',
  'Europe', 'East Asia', 'South Asia', 'Central Asia',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickN(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

function randomDate() {
  // Nov 2026, 2026-11-01 through 2026-11-30
  const start = new Date('2026-11-01T08:00:00Z');
  const end = new Date('2026-11-30T22:00:00Z');
  const ms = start.getTime() + Math.random() * (end.getTime() - start.getTime());
  return new Date(ms).toISOString();
}

function laterDate(isoDate) {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + Math.floor(Math.random() * 7) + 1);
  return d.toISOString();
}

function makeVocations() {
  const count = Math.random() < 0.7 ? 1 : Math.random() < 0.7 ? 2 : 3;
  return pickN(VOCATIONS, count);
}

function makeHeartbeats() {
  const count = Math.random() < 0.5 ? 1 : Math.random() < 0.6 ? 2 : 3;
  return pickN(HEARTBEATS, count);
}

/**
 * Build a row object with column-based fields.
 */
function buildRow(pid, submittedAt, isTest = false) {
  const vocations = makeVocations();
  const heartbeats = makeHeartbeats();

  const row = {
    person_id: pid,
    submitted_at: submittedAt,
    is_test: isTest ? 'TRUE' : 'FALSE',
    vocation_1: vocations[0] ?? '',
    vocation_2: vocations[1] ?? '',
    vocation_3: vocations[2] ?? '',
    heartbeat_1: heartbeats[0] ?? '',
    heartbeat_2: heartbeats[1] ?? '',
    heartbeat_3: heartbeats[2] ?? '',
    connect_1_place: '',
    connect_1_city: '',
    connect_2_place: '',
    connect_2_city: '',
    connect_3_place: '',
    connect_3_city: '',
    connect_where_i_live: 'FALSE',
    lives_area: '',
    lives_place: '',
  };

  return row;
}

function applySfPlace(row, slot = 1) {
  const neighborhood = pick(SF_NEIGHBORHOODS);
  row[`connect_${slot}_place`] = `SF: ${neighborhood}`;
  row[`connect_${slot}_city`] = '';
}

function applyBayAreaPlace(row, slot = 1) {
  const prefix = pick(BAY_AREA_PREFIXES);
  const city = pick(BAY_AREA_CITIES);
  row[`connect_${slot}_place`] = `${prefix}: ${city}`;
  row[`connect_${slot}_city`] = '';
}

function applyCountryPlace(row, country, slot = 1) {
  row[`connect_${slot}_place`] = country;
  const cities = COUNTRY_CITIES[country];
  row[`connect_${slot}_city`] = cities ? pick(cities) : '';
}

function applyRegionPlace(row, region, slot = 1) {
  row[`connect_${slot}_place`] = `Region: ${region}`;
  row[`connect_${slot}_city`] = '';
}

// ---------------------------------------------------------------------------
// Generate rows
// ---------------------------------------------------------------------------

const HEADERS = [
  'person_id', 'submitted_at', 'is_test',
  'vocation_1', 'vocation_2', 'vocation_3',
  'heartbeat_1', 'heartbeat_2', 'heartbeat_3',
  'connect_1_place', 'connect_1_city',
  'connect_2_place', 'connect_2_city',
  'connect_3_place', 'connect_3_city',
  'connect_where_i_live', 'lives_area', 'lives_place',
];

function rowToArray(row) {
  return HEADERS.map(h => row[h] ?? '');
}

function generateRows() {
  const rows = [];

  // Pool of 250 unique person IDs; P001-P010 will get duplicate submissions
  const uniquePids = Array.from({ length: 250 }, (_, i) => `P${String(i + 1).padStart(3, '0')}`);

  // Track first submission dates for P001-P010
  const firstDates = {};

  let pidIdx = 0;

  function nextPid() {
    return uniquePids[pidIdx++];
  }

  // ~60 SF/Bay Area picks
  for (let i = 0; i < 60; i++) {
    const pid = nextPid();
    const d = randomDate();
    const row = buildRow(pid, d);
    if (Math.random() < 0.6) {
      applySfPlace(row, 1);
    } else {
      applyBayAreaPlace(row, 1);
    }
    // Some people also have a country
    if (Math.random() < 0.3) {
      applyCountryPlace(row, pick(COUNTRIES), 2);
    }
    rows.push(row);
  }

  // ~50 Thailand
  for (let i = 0; i < 50; i++) {
    const pid = nextPid();
    const d = randomDate();
    const row = buildRow(pid, d);
    applyCountryPlace(row, 'Thailand', 1);
    rows.push(row);
  }

  // ~40 Kenya
  for (let i = 0; i < 40; i++) {
    const pid = nextPid();
    const d = randomDate();
    const row = buildRow(pid, d);
    applyCountryPlace(row, 'Kenya', 1);
    rows.push(row);
  }

  // ~40 Philippines
  for (let i = 0; i < 40; i++) {
    const pid = nextPid();
    const d = randomDate();
    const row = buildRow(pid, d);
    applyCountryPlace(row, 'Philippines', 1);
    rows.push(row);
  }

  // ~30 Nicaragua
  for (let i = 0; i < 30; i++) {
    const pid = nextPid();
    const d = randomDate();
    const row = buildRow(pid, d);
    applyCountryPlace(row, 'Nicaragua', 1);
    rows.push(row);
  }

  // ~30 Uganda
  for (let i = 0; i < 30; i++) {
    const pid = nextPid();
    const d = randomDate();
    const row = buildRow(pid, d);
    applyCountryPlace(row, 'Uganda', 1);
    rows.push(row);
  }

  // ~20 region picks
  for (let i = 0; i < 20; i++) {
    const pid = nextPid();
    const d = randomDate();
    const row = buildRow(pid, d);
    applyRegionPlace(row, pick(REGIONS), 1);
    rows.push(row);
  }

  // ~20 misc countries
  for (let i = 0; i < 20; i++) {
    const pid = nextPid();
    const d = randomDate();
    const row = buildRow(pid, d);
    applyCountryPlace(row, pick(COUNTRIES), 1);
    rows.push(row);
  }

  // ~10 blank/minimal rows (no place picks)
  for (let i = 0; i < 10; i++) {
    const pid = nextPid();
    const d = randomDate();
    // Build row but clear out all answers to make truly minimal
    const row = buildRow(pid, d);
    row.vocation_1 = '';
    row.vocation_2 = '';
    row.vocation_3 = '';
    row.heartbeat_1 = '';
    row.heartbeat_2 = '';
    row.heartbeat_3 = '';
    rows.push(row);
  }

  // ~5 is_test=TRUE rows
  for (let i = 0; i < 5; i++) {
    const pid = nextPid();
    const d = randomDate();
    const row = buildRow(pid, d, true);
    applyCountryPlace(row, 'Thailand', 1);
    rows.push(row);
  }

  // ~10 repeat person_ids (P001-P010 appear twice)
  for (let i = 1; i <= 10; i++) {
    const pid = `P${String(i).padStart(3, '0')}`;
    // Find the first row for this pid and record its date
    const firstRow = rows.find(r => r.person_id === pid);
    if (!firstRow) continue;
    const d2 = laterDate(firstRow.submitted_at);
    const row2 = buildRow(pid, d2);
    applyCountryPlace(row2, pick(['Thailand', 'Kenya', 'Philippines']), 1);
    rows.push(row2);
  }

  // Shuffle to make it realistic
  rows.sort(() => Math.random() - 0.5);

  return rows;
}

// ---------------------------------------------------------------------------
// CSV output
// ---------------------------------------------------------------------------

function toCsv(rows) {
  const lines = [HEADERS.join(',')];
  for (const row of rows) {
    lines.push(rowToArray(row).map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  const rows = generateRows();

  if (isDryRun) {
    process.stdout.write(toCsv(rows) + '\n');
    console.error(`[seed] Dry run: ${rows.length} rows written to stdout as CSV.`);
    return;
  }

  const sheetId = process.env.SHEET_ID;
  if (!sheetId) {
    console.error('[seed] SHEET_ID env var is required for sheet write mode.');
    process.exit(1);
  }

  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // Write header row first (clearing existing data)
  await sheets.spreadsheets.values.clear({
    spreadsheetId: sheetId,
    range: 'Responses',
  });

  const values = [HEADERS, ...rows.map(rowToArray)];

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: 'Responses!A1',
    valueInputOption: 'RAW',
    requestBody: { values },
  });

  console.log(`[seed] Wrote ${rows.length} rows to Responses tab.`);
}

main().catch(err => {
  console.error('[seed] Fatal error:', err);
  process.exit(1);
});
