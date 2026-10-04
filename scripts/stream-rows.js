import 'dotenv/config';
import { google } from 'googleapis';

const SF_NEIGHBORHOODS = ['Mission', 'Sunset', 'Richmond', 'SOMA', 'Castro', 'Haight', 'Noe Valley'];
const BAY_PREFIXES = ['East Bay', 'North Bay', 'South Bay', 'Peninsula'];
const BAY_CITIES = ['Oakland', 'Berkeley', 'Fremont', 'San Jose', 'Palo Alto'];
const COUNTRIES = ['Thailand', 'Kenya', 'Philippines', 'Nicaragua', 'Uganda', 'Brazil', 'India', 'Japan'];
const COUNTRY_CITIES = {
  Thailand: ['Bangkok', 'Chiang Mai', 'Phuket'],
  Kenya: ['Nairobi', 'Mombasa'],
  Philippines: ['Manila', 'Cebu'],
  Nicaragua: ['Managua'],
  Uganda: ['Kampala'],
};
const REGIONS = ['Middle East', 'Africa', 'Southeast Asia', 'Latin America', 'Europe'];
const VOCATIONS = ['Student', 'Teacher/Educator', 'Healthcare', 'Tech/Engineering', 'Ministry/Church Work'];
const HEARTBEATS = ['Education Access', 'Unreached Peoples', 'Urban Ministry', 'Children & Youth', 'Refugees & Displacement'];

const HEADERS = [
  'person_id', 'submitted_at', 'is_test',
  'vocation_1', 'vocation_2', 'vocation_3',
  'heartbeat_1', 'heartbeat_2', 'heartbeat_3',
  'connect_1_place', 'connect_1_city',
  'connect_2_place', 'connect_2_city',
  'connect_3_place', 'connect_3_city',
  'connect_where_i_live', 'lives_area', 'lives_place',
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

let pidCounter = 5000;

function makeRow() {
  pidCounter++;
  const pid = `S${pidCounter}`;
  const now = new Date().toISOString();

  const row = {
    person_id: pid,
    submitted_at: now,
    is_test: 'FALSE',
    vocation_1: pick(VOCATIONS),
    vocation_2: Math.random() < 0.4 ? pick(VOCATIONS) : '',
    vocation_3: '',
    heartbeat_1: pick(HEARTBEATS),
    heartbeat_2: Math.random() < 0.5 ? pick(HEARTBEATS) : '',
    heartbeat_3: '',
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

  const r = Math.random();

  if (r < 0.25) {
    // SF pick
    row.connect_1_place = `SF: ${pick(SF_NEIGHBORHOODS)}`;
  } else if (r < 0.35) {
    // Bay Area pick
    row.connect_1_place = `${pick(BAY_PREFIXES)}: ${pick(BAY_CITIES)}`;
  } else if (r < 0.55) {
    // Thailand
    row.connect_1_place = 'Thailand';
    row.connect_1_city = pick(COUNTRY_CITIES.Thailand);
  } else if (r < 0.70) {
    // Kenya or Philippines
    const c = Math.random() < 0.5 ? 'Kenya' : 'Philippines';
    row.connect_1_place = c;
    row.connect_1_city = pick(COUNTRY_CITIES[c]);
  } else if (r < 0.80) {
    // Region
    row.connect_1_place = `Region: ${pick(REGIONS)}`;
  } else {
    // Random country
    const c = pick(COUNTRIES);
    row.connect_1_place = c;
    row.connect_1_city = COUNTRY_CITIES[c] ? pick(COUNTRY_CITIES[c]) : '';
  }

  return row;
}

async function main() {
  const args = process.argv.slice(2);
  const intervalIdx = args.indexOf('--interval');
  const intervalMs = intervalIdx !== -1 ? parseInt(args[intervalIdx + 1]) || 3000 : 3000;

  const sheetId = process.env.SHEET_ID;
  if (!sheetId) {
    console.error('[stream] SHEET_ID env var is required.');
    process.exit(1);
  }

  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  console.log(`[stream] Appending 1 row every ${intervalMs}ms. Ctrl+C to stop.`);

  async function appendRow() {
    const row = makeRow();
    const values = [HEADERS.map(h => row[h] ?? '')];

    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: 'Responses',
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values },
      });
      console.log(`[stream] Appended: pid=${row.person_id} place="${row.connect_1_place}" city="${row.connect_1_city}"`);
    } catch (err) {
      console.error('[stream] Append failed:', err.message);
    }
  }

  // Run first append immediately, then on interval
  await appendRow();
  setInterval(appendRow, intervalMs);
}

main().catch(err => {
  console.error('[stream] Fatal error:', err);
  process.exit(1);
});
