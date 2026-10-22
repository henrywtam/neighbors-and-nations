/**
 * gen-demo-state.js
 *
 * Generates a realistic ProcessedState as JSON at data/demo-state.json, used by
 * DEMO_MODE=true in index.js. No Sheet API calls needed.
 *
 * Simulates 247 respondents filling in the real form (same option lists, same
 * row format sync-pc writes) and runs them through the real processor, so the
 * demo lights the map the way a full survey would.
 *
 * Usage: node scripts/gen-demo-state.js
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { processResponses } from '../src/processor.js';
import * as geonames from '../src/geonames.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PEOPLE = 247;

// Seeded RNG so the demo is the same on every run
let seed = 20261021;
function rand() {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Pick one key from {key: weight}. */
function weighted(weights) {
  const entries = Object.entries(weights);
  let r = rand() * entries.reduce((sum, [, w]) => sum + w, 0);
  for (const [key, w] of entries) {
    if ((r -= w) < 0) return key;
  }
  return entries[entries.length - 1][0];
}

/** Pick n distinct items from a list, earlier items more likely. */
function pickDistinct(list, n, bias = 1.6) {
  const out = new Set();
  while (out.size < Math.min(n, list.length)) {
    out.add(list[Math.floor(rand() ** bias * list.length)]);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Form option lists (from Planning Center form 1335453)
// ---------------------------------------------------------------------------

const VOCATIONS = [
  'Software & Product', 'Healthcare & Mental Health', 'Education', 'Student',
  'Business & Finance', 'Church & Ministry', 'Arts, Media & Design', 'AI & Data',
  'Nonprofit & Social Services', 'Engineering (hardware, civil, mechanical)',
  'Law, Government & Policy', 'Science & Research', 'Hospitality & Food',
  'Trades, Construction & Real Estate', 'Caregiving & Home', 'Retired',
];

const HEARTBEATS = [
  'Homelessness & Housing', 'Mental Health', 'Immigrants & Refugees',
  'Poverty & Economic Opportunity', 'Children & Education', 'Human Trafficking',
  'Justice & Human Rights', 'Racial Reconciliation', 'Hunger & Clean Water',
  'Youth & Young Adults', 'Evangelism', 'Foster Care & Family', 'Addiction Recovery',
  'Environment & Creation Care', 'Domestic Violence & Abuse', 'Health Care',
  'Disaster & War Relief', 'Incarceration & Reentry', 'Disability', 'Seniors',
];

const SF_NEIGHBORHOODS = [
  'Mission', 'Inner Sunset', 'Outer Sunset/Parkside', 'Inner Richmond', 'Outer Richmond',
  'Noe Valley', 'Bernal Heights', 'SoMa', 'Castro/Upper Market', 'Hayes Valley',
  'Western Addition', 'Lone Mountain/NOPA', 'Excelsior', 'Potrero Hill', 'Dogpatch',
  'Mission Bay', 'Glen Park', 'Haight Ashbury', 'Cole Valley', 'Marina', 'Nob Hill',
  'Russian Hill', 'North Beach', 'Chinatown', 'Pacific Heights', 'Visitacion Valley',
  'Bayview Hunters Point', 'Tenderloin', 'Ingleside', 'Portola', 'Twin Peaks',
];

const BAY_CITIES = {
  'East Bay': ['Oakland', 'Berkeley', 'Alameda', 'Emeryville', 'Fremont', 'Walnut Creek'],
  'Peninsula': ['Daly City', 'South San Francisco', 'San Mateo', 'Redwood City', 'Palo Alto'],
  'South Bay': ['San Jose', 'Mountain View', 'Sunnyvale', 'Santa Clara', 'Cupertino'],
  'North Bay': [''],
};

// Region dropdown options, and the Regions tab mapping (country → region)
const REGION_COUNTRIES = {
  'Africa': ['Kenya', 'Uganda', 'Ethiopia', 'Nigeria', 'Ghana', 'Tanzania', 'Rwanda', 'Zambia', 'Zimbabwe', 'Mozambique', 'Madagascar', 'Senegal', 'South Africa', 'Egypt', 'Morocco', 'Angola', 'Cameroon', 'Democratic Republic of the Congo', 'Malawi', 'Sudan', 'South Sudan', 'Burundi', 'Liberia', 'Sierra Leone', 'Mali', 'Niger', 'Chad', 'Somalia', 'Botswana', 'Namibia', 'Tunisia', 'Algeria', 'Ivory Coast', 'Burkina Faso', 'Benin', 'Togo', 'Guinea', 'Eritrea', 'Libya'],
  'East & Southeast Asia': ['China', 'Japan', 'South Korea', 'Taiwan', 'Mongolia', 'Hong Kong', 'Thailand', 'Philippines', 'Vietnam', 'Cambodia', 'Myanmar', 'Malaysia', 'Singapore', 'Indonesia', 'Laos', 'North Korea'],
  'Eastern Europe & Russia': ['Russia', 'Ukraine', 'Poland', 'Romania', 'Hungary', 'Czech Republic', 'Bulgaria', 'Serbia', 'Moldova', 'Belarus', 'Georgia', 'Armenia', 'Albania', 'Croatia', 'Bosnia and Herzegovina', 'Slovakia', 'Lithuania', 'Latvia', 'Estonia'],
  'Latin America': ['Mexico', 'Guatemala', 'Honduras', 'El Salvador', 'Nicaragua', 'Costa Rica', 'Panama', 'Colombia', 'Venezuela', 'Ecuador', 'Peru', 'Bolivia', 'Brazil', 'Chile', 'Argentina', 'Paraguay', 'Uruguay', 'Cuba', 'Haiti', 'Dominican Republic', 'Jamaica', 'Puerto Rico', 'Guyana'],
  'Middle East': ['Israel', 'Jordan', 'Lebanon', 'Syria', 'Iraq', 'Iran', 'Saudi Arabia', 'Turkey', 'Yemen', 'United Arab Emirates', 'Oman', 'Qatar', 'Kuwait'],
  'North America': ['United States', 'Canada', 'Greenland'],
  'Pacific / Oceania': ['Australia', 'New Zealand', 'Papua New Guinea', 'Fiji', 'Solomon Islands', 'Samoa', 'Vanuatu'],
  'South & Central Asia': ['India', 'Pakistan', 'Bangladesh', 'Nepal', 'Sri Lanka', 'Afghanistan', 'Bhutan', 'Kazakhstan', 'Uzbekistan', 'Kyrgyzstan', 'Tajikistan', 'Turkmenistan'],
  'Western Europe': ['United Kingdom', 'Ireland', 'France', 'Germany', 'Netherlands', 'Belgium', 'Spain', 'Portugal', 'Italy', 'Switzerland', 'Austria', 'Sweden', 'Norway', 'Denmark', 'Finland', 'Iceland', 'Greece'],
};

// Country picks: a heavy head (global partners + heritage countries) and a long
// tail — every country in the Regions mapping can come up
const COUNTRY_WEIGHTS = {
  'Thailand': 30, 'Kenya': 24, 'Philippines': 24, 'Mexico': 22, 'China': 20,
  'Nicaragua': 16, 'Uganda': 16, 'South Korea': 15, 'India': 15, 'Vietnam': 12,
  'Japan': 10, 'Taiwan': 9, 'Guatemala': 8, 'Brazil': 8, 'Israel': 8, 'Ukraine': 7,
  'Indonesia': 7, 'Cambodia': 7, 'United Kingdom': 6, 'Ethiopia': 6, 'Nigeria': 6,
  'El Salvador': 6, 'Haiti': 5, 'Colombia': 5, 'Peru': 5, 'Germany': 5, 'France': 5,
  'Canada': 5, 'Myanmar': 5, 'Rwanda': 5, 'South Africa': 4, 'Egypt': 4, 'Turkey': 4,
  'Jordan': 4, 'Lebanon': 4, 'Iran': 4, 'Nepal': 4, 'Bangladesh': 4, 'Pakistan': 4,
  'Australia': 4, 'Russia': 4, 'Spain': 4, 'Italy': 4, 'Ghana': 3, 'Tanzania': 3,
  'Honduras': 3, 'Dominican Republic': 3, 'Ecuador': 3, 'Argentina': 3, 'Chile': 3,
  'Malaysia': 3, 'Mongolia': 3, 'Laos': 3, 'Sri Lanka': 3, 'Poland': 3, 'Romania': 3,
  'Ireland': 3, 'Netherlands': 3, 'Greece': 3, 'Iraq': 3, 'Syria': 3,
};
for (const countries of Object.values(REGION_COUNTRIES)) {
  for (const c of countries) COUNTRY_WEIGHTS[c] ??= 1;
}

// City picks, typed the way people would ([city, country]). Only cities in
// data/cities15k.json resolve, so the list sticks to those.
const CITY_WEIGHTS = {
  'San Francisco|United States': 14, 'Bangkok|Thailand': 12, 'Manila|Philippines': 10,
  'Nairobi|Kenya': 10, 'Mexico City|Mexico': 8, 'Seoul|South Korea': 7, 'Tokyo|Japan': 7,
  'Shanghai|China': 6, 'Ho Chi Minh City|Vietnam': 5,
  'Chiang Mai|Thailand': 5, 'Kampala|Uganda': 5, 'Managua|Nicaragua': 5, 'Mumbai|India': 4,
  'London|United Kingdom': 4, 'Los Angeles|United States': 4, 'New York City|United States': 4,
  'Guatemala City|Guatemala': 3, 'Beijing|China': 3, 'Cebu City|Philippines': 3,
  'Phnom Penh|Cambodia': 3, 'Singapore|Singapore': 3, 'Kyiv|Ukraine': 3,
  'Addis Ababa|Ethiopia': 2, 'Lagos|Nigeria': 2, 'Kigali|Rwanda': 2, 'Cairo|Egypt': 2,
  'Istanbul|Turkey': 2, 'Amman|Jordan': 2, 'Beirut|Lebanon': 2, 'Delhi|India': 2,
  'Kathmandu|Nepal': 2, 'Dhaka|Bangladesh': 2, 'Paris|France': 2, 'Berlin|Germany': 2,
  'Madrid|Spain': 2, 'Rome|Italy': 2, 'Toronto|Canada': 2,
  'São Paulo|Brazil': 2, 'Bogotá|Colombia': 2, 'Lima|Peru': 2, 'Buenos Aires|Argentina': 2,
  'Santiago|Chile': 1, 'San Salvador|El Salvador': 1, 'Port-au-Prince|Haiti': 1,
  'Sydney|Australia': 2, 'Auckland|New Zealand': 1, 'Ulaanbaatar|Mongolia': 1, 'Yangon|Myanmar': 1,
  'Kuala Lumpur|Malaysia': 1, 'Osaka|Japan': 1, 'Busan|South Korea': 1, 'Accra|Ghana': 1,
  'Dar es Salaam|Tanzania': 1, 'Cape Town|South Africa': 1, 'Johannesburg|South Africa': 1,
  'Moscow|Russia': 1, 'Warsaw|Poland': 1, 'Dublin|Ireland': 1,
  'Amsterdam|Netherlands': 1, 'Honolulu|United States': 1, 'Chicago|United States': 1,
  'Houston|United States': 1, 'Seattle|United States': 1,
};

// ---------------------------------------------------------------------------
// Simulate respondents (rows in the shape sync-pc writes to the Responses tab)
// ---------------------------------------------------------------------------

function makePlace() {
  const kind = weighted({ country: 55, city: 30, region: 15 });
  if (kind === 'country') return { place: weighted(COUNTRY_WEIGHTS), city: '' };
  if (kind === 'region') return { place: `Region: ${weighted(Object.fromEntries(Object.keys(REGION_COUNTRIES).map(r => [r, 1])))}`, city: '' };
  const [city, country] = weighted(CITY_WEIGHTS).split('|');
  return { place: `City: ${country}`, city };
}

function makeRow(i) {
  const row = {
    person_id: `DEMO${String(i).padStart(4, '0')}`,
    submitted_at: new Date(Date.UTC(2026, 9, 1) + i * 3_600_000).toISOString(),
    is_test: 'FALSE',
    connect_where_i_live: 'FALSE',
  };

  pickDistinct(VOCATIONS, 1 + Math.floor(rand() * 3)).forEach((v, n) => { row[`vocation_${n + 1}`] = v; });
  pickDistinct(HEARTBEATS, 1 + Math.floor(rand() * 3)).forEach((h, n) => { row[`heartbeat_${n + 1}`] = h; });

  const area = weighted({ SF: 70, 'East Bay': 14, Peninsula: 8, 'South Bay': 5, 'North Bay': 3 });
  const place = area === 'SF'
    ? pickDistinct(SF_NEIGHBORHOODS, 1, 1.4)[0]
    : BAY_CITIES[area][Math.floor(rand() * BAY_CITIES[area].length)];
  row.lives_area = area;
  row.lives_place = place ? `${area}: ${place}` : area;

  // Most people share 2–3 places; a few skip the question
  const placeCount = weighted({ 0: 6, 1: 20, 2: 30, 3: 44 });
  for (let n = 1; n <= 3; n++) {
    const p = n <= placeCount ? makePlace() : { place: '', city: '' };
    row[`connect_${n}_place`] = p.place;
    row[`connect_${n}_city`] = p.city;
  }
  return row;
}

await geonames.initGeonames(join(__dirname, '..', 'data', 'cities15k.json'));

const regionMap = new Map();
for (const [region, countries] of Object.entries(REGION_COUNTRIES)) {
  for (const c of countries) regionMap.set(c, region);
}

const responses = Array.from({ length: PEOPLE }, (_, i) => makeRow(i + 1));
const state = processResponses(
  { responses, regionMap, approvals: new Map(), readAt: new Date() },
  { showTestRows: false },
  geonames,
);

// Same plain-object shape index.js's serializeState produces
const out = {
  ...state,
  countryPicks: Object.fromEntries(state.countryPicks),
  regionPicks: Object.fromEntries(state.regionPicks),
  regionCountries: Object.fromEntries(state.regionCountries),
  heartbeatCounts: Object.fromEntries(state.heartbeatCounts),
  vocationCounts: Object.fromEntries(state.vocationCounts),
};

const outPath = join(__dirname, '..', 'data', 'demo-state.json');
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${outPath}`);
console.log(`  ${out.totalPeople} people, ${Object.keys(out.countryPicks).length} countries lit, ` +
  `${out.cityPicks.length} cities, ${Object.keys(out.regionPicks).length} regions`);
if (out.unmatchedCountries.length) console.log('  unmatched countries:', out.unmatchedCountries.join(', '));
if (out.unmatchedCities.length) console.log('  unmatched cities:', out.unmatchedCities.map(c => c.city).join(', '));
