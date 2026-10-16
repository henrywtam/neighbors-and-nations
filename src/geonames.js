import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Countries — single source of truth shared with the frontend map.
// Each entry: { name, alpha2, num (ISO numeric, zero-padded), shapes?, aliases? }
// ---------------------------------------------------------------------------

export const countries = JSON.parse(
  readFileSync(new URL('../public/data/countries.json', import.meta.url), 'utf-8'),
);

/** Canonical country name → ISO alpha-2 code */
export const countryNameToCode = Object.fromEntries(countries.map(c => [c.name, c.alpha2]));

/** Lowercase alias (incl. territories rolled into a parent) → canonical country name */
export const countryAliases = Object.fromEntries(
  countries.flatMap(c => (c.aliases ?? []).map(a => [a, c.name])),
);

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
