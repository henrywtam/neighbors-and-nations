import { readFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Country name → ISO alpha-2 code
// ---------------------------------------------------------------------------

export const countryNameToCode = {
  'Thailand': 'TH',
  'Kenya': 'KE',
  'Philippines': 'PH',
  'Nicaragua': 'NI',
  'Uganda': 'UG',
  'United States': 'US',
  'Brazil': 'BR',
  'China': 'CN',
  'India': 'IN',
  'Japan': 'JP',
  'United Kingdom': 'GB',
  'Germany': 'DE',
  'France': 'FR',
  'Mexico': 'MX',
  'South Korea': 'KR',
  'Indonesia': 'ID',
  'Nigeria': 'NG',
  'Ethiopia': 'ET',
  'South Africa': 'ZA',
  'Egypt': 'EG',
  'Colombia': 'CO',
  'Argentina': 'AR',
  'Australia': 'AU',
  'Canada': 'CA',
  'Vietnam': 'VN',
  'Cambodia': 'KH',
  'Laos': 'LA',
  'Myanmar': 'MM',
  'Malaysia': 'MY',
  'Singapore': 'SG',
  'Bangladesh': 'BD',
  'Pakistan': 'PK',
  'Afghanistan': 'AF',
  'Iran': 'IR',
  'Iraq': 'IQ',
  'Saudi Arabia': 'SA',
  'Israel': 'IL',
  'Jordan': 'JO',
  'Lebanon': 'LB',
  'Syria': 'SY',
  'Turkey': 'TR',
  'Ukraine': 'UA',
  'Russia': 'RU',
  'Poland': 'PL',
  'Spain': 'ES',
  'Italy': 'IT',
  'Portugal': 'PT',
  'Netherlands': 'NL',
  'Belgium': 'BE',
  'Sweden': 'SE',
  'Norway': 'NO',
  'Denmark': 'DK',
  'Finland': 'FI',
  'Switzerland': 'CH',
  'Austria': 'AT',
  'New Zealand': 'NZ',
  'Peru': 'PE',
  'Chile': 'CL',
  'Bolivia': 'BO',
  'Ecuador': 'EC',
  'Venezuela': 'VE',
  'Guatemala': 'GT',
  'Honduras': 'HN',
  'El Salvador': 'SV',
  'Costa Rica': 'CR',
  'Panama': 'PA',
  'Cuba': 'CU',
  'Haiti': 'HT',
  'Dominican Republic': 'DO',
  'Jamaica': 'JM',
  'Morocco': 'MA',
  'Tunisia': 'TN',
  'Algeria': 'DZ',
  'Libya': 'LY',
  'Ghana': 'GH',
  'Tanzania': 'TZ',
  'Rwanda': 'RW',
  'Zambia': 'ZM',
  'Zimbabwe': 'ZW',
  'Mozambique': 'MZ',
  'Madagascar': 'MG',
  'Senegal': 'SN',
  'Mali': 'ML',
  'Burkina Faso': 'BF',
  'Niger': 'NE',
  'Chad': 'TD',
  'Sudan': 'SD',
  'South Sudan': 'SS',
  'Democratic Republic of Congo': 'CD',
  'Cameroon': 'CM',
  'Angola': 'AO',
  'Sri Lanka': 'LK',
  'Nepal': 'NP',
  'United Arab Emirates': 'AE',
  'Greece': 'GR',
  'Czech Republic': 'CZ',
  'Hungary': 'HU',
  'Romania': 'RO',
  'Serbia': 'RS',
  'Croatia': 'HR',
};

// ---------------------------------------------------------------------------
// In-memory city database
// ---------------------------------------------------------------------------

/** @type {Array<{name: string, countryCode: string, lat: number, lng: number, population: number, altNames: string[]}>} */
let cities = [];
let loaded = false;

/**
 * Load cities JSON file into memory.
 * @param {string} citiesJsonPath - absolute path to cities JSON file
 */
export async function initGeonames(citiesJsonPath) {
  const raw = await readFile(citiesJsonPath, 'utf-8');
  cities = JSON.parse(raw);
  loaded = true;
}

// Reverse map: ISO alpha-2 → country name (derived from countryNameToCode)
export const countryCodeToName = Object.fromEntries(
  Object.entries(countryNameToCode).map(([name, code]) => [code, name]),
);

/**
 * Look up a city by name and country name.
 * Returns the highest-population match, or null if not found.
 *
 * @param {string} cityName
 * @param {string} countryName - full country name (will be converted to code)
 * @returns {{lat: number, lng: number, population: number}|null}
 */
export function lookupCity(cityName, countryName) {
  if (!loaded || !cityName || !countryName) return null;

  const targetCode = countryNameToCode[countryName];
  if (!targetCode) return null;

  const normalizedQuery = normalize(cityName);

  const candidates = cities.filter(c => {
    if (c.countryCode !== targetCode) return false;
    if (normalize(c.name) === normalizedQuery) return true;
    if (c.altNames && c.altNames.some(a => normalize(a) === normalizedQuery)) return true;
    return false;
  });

  if (candidates.length === 0) return null;

  // Return highest population
  candidates.sort((a, b) => (b.population ?? 0) - (a.population ?? 0));
  const { lat, lng, population } = candidates[0];
  return { lat, lng, population };
}

/**
 * Look up a city by name globally (no country constraint).
 * Returns the highest-population match with its country name, or null.
 *
 * Used for Planning Center "City" type connections where no country is provided.
 *
 * @param {string} cityName
 * @returns {{lat: number, lng: number, population: number, countryCode: string, countryName: string|null}|null}
 */
export function lookupCityGlobal(cityName) {
  if (!loaded || !cityName) return null;

  const normalizedQuery = normalize(cityName);

  const candidates = cities.filter(c => {
    if (normalize(c.name) === normalizedQuery) return true;
    if (c.altNames && c.altNames.some(a => normalize(a) === normalizedQuery)) return true;
    return false;
  });

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => (b.population ?? 0) - (a.population ?? 0));
  const { lat, lng, population, countryCode } = candidates[0];
  return { lat, lng, population, countryCode, countryName: countryCodeToName[countryCode] ?? null };
}

function normalize(str) {
  return str.toLowerCase().trim().replace(/\s+/g, ' ');
}
