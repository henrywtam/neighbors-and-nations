/**
 * processor.js
 *
 * Pure data transformation: takes SheetData + config + geonames module
 * and produces ProcessedState. No I/O.
 */

// ---------------------------------------------------------------------------
// parsePlaceValue
// ---------------------------------------------------------------------------

/**
 * Parse a raw connect place value into a typed structure.
 *
 * @param {string} value
 * @returns {{type: 'sf'|'bayarea'|'region'|'country', value: string}|null}
 */
export function parsePlaceValue(value) {
  if (!value || typeof value !== 'string') return null;
  const v = value.trim();
  if (!v) return null;

  if (v.startsWith('City: ')) {
    return { type: 'city_in_country', value: v.slice(6).trim() };
  }
  if (v.startsWith('SF: ')) {
    return { type: 'sf', value: v.slice(4).trim() };
  }
  if (
    v.startsWith('East Bay: ') ||
    v.startsWith('North Bay: ') ||
    v.startsWith('South Bay: ') ||
    v.startsWith('Peninsula: ')
  ) {
    const colonIdx = v.indexOf(': ');
    return { type: 'bayarea', value: v.slice(colonIdx + 2).trim() };
  }
  if (v.startsWith('Region: ')) {
    return { type: 'region', value: v.slice(8).trim() };
  }
  // No prefix → country
  return { type: 'country', value: v };
}

// ---------------------------------------------------------------------------
// processResponses
// ---------------------------------------------------------------------------

/**
 * @param {object} sheetData
 * @param {object} config
 * @param {object} geonames  - must expose lookupCity(cityName, countryName)
 * @returns {ProcessedState}
 */
export function processResponses(sheetData, config, geonames) {
  const { responses = [], regionMap = new Map(), approvals = new Map(), readAt } = sheetData;

  // -------------------------------------------------------------------------
  // Step 1: Deduplicate by person_id — keep only the latest submitted_at
  // -------------------------------------------------------------------------
  const byPerson = new Map();
  for (const row of responses) {
    const pid = (row.person_id ?? '').trim();
    if (!pid) continue;

    const ts = parseDate(row.submitted_at);
    const existing = byPerson.get(pid);
    if (!existing || ts > existing._ts) {
      byPerson.set(pid, { ...row, _ts: ts });
    }
  }

  // -------------------------------------------------------------------------
  // Step 2: Filter and count
  // -------------------------------------------------------------------------
  const countryPicks = new Map();
  const regionPicks = new Map();
  /** @type {Map<string, {lat: number, lng: number, count: number, name: string, countryCode: string}>} */
  const cityPicksMap = new Map(); // key = `${lat},${lng}`
  let sfBayCount = 0;
  const sfNeighborhoodCounts = new Map(); // 'Mission' → 3

  // heartbeat/vocation: Map<label, {count, respondents: Set<pid>}>
  const heartbeatCounts = new Map();
  const vocationCounts = new Map();

  // Track how many people answered each question type
  const heartbeatRespondents = new Set();
  const vocationRespondents = new Set();

  const unmatchedCountries = new Set(); // countries with no ISO code
  const unmatchedCities = new Map();    // key = `city|country` → {city, country}
  let invalidRowCount = 0;
  let totalPeople = 0;

  for (const [pid, row] of byPerson) {
    // -----------------------------------------------------------------------
    // Filter: test rows
    // -----------------------------------------------------------------------
    if (!config.showTestRows) {
      if (row.is_test === 'TRUE' || row.is_test === true) {
        continue;
      }
    }

    // -----------------------------------------------------------------------
    // Check if row has any answers
    // -----------------------------------------------------------------------
    const hasVocations = hasAnyValue(row, 'vocation');
    const hasHeartbeats = hasAnyValue(row, 'heartbeat');
    const hasConnectPlaces = hasAnyConnect(row);
    const hasLives = row.lives_place && row.lives_place.trim();

    if (!hasVocations && !hasHeartbeats && !hasConnectPlaces && !hasLives) {
      invalidRowCount++;
      continue;
    }

    totalPeople++;

    // -----------------------------------------------------------------------
    // Collect all connect place values for this person
    // -----------------------------------------------------------------------
    const placeValues = [];

    // connect_1_place, connect_2_place, connect_3_place
    for (let n = 1; n <= 3; n++) {
      const placeKey = `connect_${n}_place`;
      const cityKey = `connect_${n}_city`;
      const place = (row[placeKey] ?? '').trim();
      const city = (row[cityKey] ?? '').trim();
      if (place) placeValues.push({ place, city });
    }

    // connect_where_i_live
    if (
      row.connect_where_i_live === 'TRUE' || row.connect_where_i_live === true
    ) {
      const livesArea = (row.lives_area ?? '').trim();
      const livesPlace = (row.lives_place ?? '').trim();
      if (livesPlace && livesArea && livesArea !== 'Elsewhere') {
        placeValues.push({ place: livesPlace, city: '' });
      }
    }

    // -----------------------------------------------------------------------
    // Process places for this person (deduplicate country/region/sfbay per person)
    // -----------------------------------------------------------------------
    let personHasSfBay = false;
    const personCountries = new Set();
    const personRegions = new Set();

    for (const { place, city } of placeValues) {
      // City typed but geonames couldn't resolve a country — log it, skip counting
      if (!place && city) {
        const umKey = city.toLowerCase();
        if (!unmatchedCities.has(umKey)) {
          unmatchedCities.set(umKey, { city, country: null });
        }
        continue;
      }

      const parsed = parsePlaceValue(place);
      if (!parsed) continue;

      if (parsed.type === 'city_in_country') {
        // City-type pick: plot dot only, do NOT highlight the country
        const countryName = parsed.value;
        if (city) {
          const cityCoords = geonames.lookupCity?.(city, countryName) ?? null;
          if (cityCoords) {
            const key = `${cityCoords.lat.toFixed(4)},${cityCoords.lng.toFixed(4)}`;
            if (cityPicksMap.has(key)) {
              cityPicksMap.get(key).count++;
            } else {
              const code = geonames.countryNameToCode?.[countryName] ?? '';
              cityPicksMap.set(key, { name: city, countryCode: code, lat: cityCoords.lat, lng: cityCoords.lng, count: 1 });
            }
          } else {
            const umKey = `${city.toLowerCase()}|${countryName.toLowerCase()}`;
            if (!unmatchedCities.has(umKey)) unmatchedCities.set(umKey, { city, country: countryName });
          }
        }
      } else if (parsed.type === 'sf' || parsed.type === 'bayarea') {
        personHasSfBay = true;
        // no country/region accumulation for SF/Bay Area
      } else if (parsed.type === 'region') {
        personRegions.add(parsed.value);
        // region pick does NOT add to country picks
      } else if (parsed.type === 'country') {
        const countryName = parsed.value;
        const hasIsoCode = !!(geonames.countryNameToCode?.[countryName]);

        if (!hasIsoCode) {
          // Unknown country — log it but don't count toward map or picks
          unmatchedCountries.add(countryName);
        } else {
          personCountries.add(countryName);

          // City lookup only for known countries
          if (city) {
            const cityCoords = geonames.lookupCity?.(city, countryName) ?? null;
            if (cityCoords) {
              const key = `${cityCoords.lat.toFixed(4)},${cityCoords.lng.toFixed(4)}`;
              if (cityPicksMap.has(key)) {
                cityPicksMap.get(key).count++;
              } else {
                const code = geonames.countryNameToCode?.[countryName] ?? '';
                cityPicksMap.set(key, {
                  name: city,
                  countryCode: code,
                  lat: cityCoords.lat,
                  lng: cityCoords.lng,
                  count: 1,
                });
              }
            } else {
              const umKey = `${city.toLowerCase()}|${countryName.toLowerCase()}`;
              if (!unmatchedCities.has(umKey)) {
                unmatchedCities.set(umKey, { city, country: countryName });
              }
            }
          }
        }
      }
    }

    // SF neighborhood count (from lives_place = "SF: <neighborhood>")
    if (row.lives_area === 'SF') {
      const livesPlace = (row.lives_place ?? '').trim();
      const match = livesPlace.match(/^SF: (.+)$/);
      if (match) {
        const nbhd = normalizeSfNeighborhood(match[1].trim());
        sfNeighborhoodCounts.set(nbhd, (sfNeighborhoodCounts.get(nbhd) ?? 0) + 1);
      }
    }

    if (personHasSfBay) sfBayCount++;
    for (const c of personCountries) increment(countryPicks, c);
    for (const r of personRegions) increment(regionPicks, r);

    // -----------------------------------------------------------------------
    // Vocations (multi-select fields: vocation_1 ... vocation_N)
    // -----------------------------------------------------------------------
    const personVocations = collectMultiSelect(row, 'vocation');
    if (personVocations.length > 0) {
      vocationRespondents.add(pid);
      const seen = new Set();
      for (const raw of personVocations) {
        const label = resolveLabel(raw, approvals);
        if (seen.has(label)) continue;
        seen.add(label);
        incrementLabelCount(vocationCounts, label, pid);
      }
    }

    // -----------------------------------------------------------------------
    // Heartbeats
    // -----------------------------------------------------------------------
    const personHeartbeats = collectMultiSelect(row, 'heartbeat');
    if (personHeartbeats.length > 0) {
      heartbeatRespondents.add(pid);
      const seen = new Set();
      for (const raw of personHeartbeats) {
        const label = resolveLabel(raw, approvals);
        if (seen.has(label)) continue;
        seen.add(label);
        incrementLabelCount(heartbeatCounts, label, pid);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Finalize heartbeat/vocation totals
  // -------------------------------------------------------------------------
  const heartbeatCountsFinal = new Map();
  for (const [label, { count }] of heartbeatCounts) {
    heartbeatCountsFinal.set(label, { count, total: heartbeatRespondents.size });
  }

  const vocationCountsFinal = new Map();
  for (const [label, { count }] of vocationCounts) {
    vocationCountsFinal.set(label, { count, total: vocationRespondents.size });
  }

  // -------------------------------------------------------------------------
  // topPlaces
  // -------------------------------------------------------------------------
  const topPlacesRaw = [];

  for (const [name, count] of countryPicks) {
    topPlacesRaw.push({ name, type: 'country', count, pct: totalPeople > 0 ? (count / totalPeople) * 100 : 0 });
  }
  for (const [name, count] of regionPicks) {
    topPlacesRaw.push({ name, type: 'region', count, pct: totalPeople > 0 ? (count / totalPeople) * 100 : 0 });
  }
  if (sfBayCount > 0) {
    topPlacesRaw.push({ name: 'SF / Bay Area', type: 'sfbay', count: sfBayCount, pct: totalPeople > 0 ? (sfBayCount / totalPeople) * 100 : 0 });
  }

  topPlacesRaw.sort((a, b) => b.count - a.count);
  const topPlaces = topPlacesRaw.slice(0, 20);

  // -------------------------------------------------------------------------
  // cityPicks array
  // -------------------------------------------------------------------------
  const cityPicks = Array.from(cityPicksMap.values());

  // -------------------------------------------------------------------------
  // regionCountries: invert regionMap → Map<regionName, countryName[]>
  // -------------------------------------------------------------------------
  const regionCountries = new Map();
  for (const [country, region] of sheetData.regionMap) {
    if (!regionCountries.has(region)) regionCountries.set(region, []);
    regionCountries.get(region).push(country);
  }

  return {
    totalPeople,
    countryPicks,
    regionPicks,
    regionCountries,
    cityPicks,
    sfBayCount,
    sfNeighborhoodCounts: Object.fromEntries(sfNeighborhoodCounts),
    heartbeatCounts: heartbeatCountsFinal,
    vocationCounts: vocationCountsFinal,
    topPlaces,
    unmatchedCountries: [...unmatchedCountries].sort(),
    unmatchedCities: [...unmatchedCities.values()],
    invalidRowCount,
    rowCount: responses.length,
    readAt: readAt ?? null,
    isLive: true,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDate(value) {
  if (!value) return new Date(0);
  const d = new Date(value);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function incrementLabelCount(map, label, _pid) {
  const entry = map.get(label);
  if (entry) {
    entry.count++;
  } else {
    map.set(label, { count: 1 });
  }
}

/**
 * Returns true if the row has any non-empty field whose key starts with prefix.
 */
function hasAnyValue(row, prefix) {
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith(prefix) && v && String(v).trim()) return true;
  }
  return false;
}

function hasAnyConnect(row) {
  for (const [k, v] of Object.entries(row)) {
    if ((k.startsWith('connect_') || k === 'lives_place') && v && String(v).trim()) return true;
  }
  return false;
}

/**
 * Collect all non-empty values for fields named `${prefix}_1`, `${prefix}_2`, etc.
 * Also handles write-in fields like `${prefix}_1_other`.
 */
function collectMultiSelect(row, prefix) {
  const results = [];
  for (const [k, v] of Object.entries(row)) {
    if (!k.startsWith(prefix + '_')) continue;
    if (!v || !String(v).trim()) continue;
    results.push(String(v).trim());
  }
  return results;
}

/**
 * Resolve a raw label value through the approvals map.
 * - "Other" with blank write-in → "Other"
 * - If value is "Other" and there's an associated write-in (handled upstream) → use write-in
 * - Write-in in approvals with approved=true, showAs non-blank → showAs
 * - Write-in in approvals with approved=true, showAs blank → own text
 * - Write-in NOT in approvals or approved=false → "Other"
 */
function resolveLabel(raw, approvals) {
  if (!raw || raw.trim() === '') return 'Other';

  const trimmed = raw.trim();

  // Check if this is a known standard label (starts with capital, not a write-in)
  // We identify write-ins as values NOT found in our known list by checking approvals
  // Actually: we check approvals for all values. Standard labels just pass through.
  const key = trimmed.toLowerCase();
  const approval = approvals.get(key);

  if (approval !== undefined) {
    // It's in the approvals map
    if (approval.approved) {
      if (approval.showAs && approval.showAs.trim()) {
        return approval.showAs.trim();
      }
      return trimmed; // show under own text
    } else {
      return 'Other';
    }
  }

  // Not in approvals map → treat as standard label (pass through)
  // This covers all the standard vocation/heartbeat values
  return trimmed;
}

// ---------------------------------------------------------------------------
// SF neighborhood normalization
// Maps whatever the Planning Center form stores → canonical display name.
// Groups like Inner/Outer Sunset → "Sunset" so both GeoJSON polygons glow.
// ---------------------------------------------------------------------------
// Maps form values → GeoJSON feature names.
// Only needed where the PC form option text differs from the GeoJSON name.
// GeoJSON names: https://github.com/codeforamerica/click_that_hood (SF)
const SF_NBHD_ALIASES = {
  // Castro/Upper Market — form variants
  'castro':                         'Castro/Upper Market',
  'upper market':                   'Castro/Upper Market',
  // Bayview Hunters Point — form variants
  'bayview-hunters point':          'Bayview Hunters Point',
  'hunters point':                  'Bayview Hunters Point',
  // Ingleside — not its own polygon, falls under combined area
  'ingleside':                      'Oceanview/Merced/Ingleside',
  'ocean view':                     'Oceanview/Merced/Ingleside',
  // Outer Sunset / Parkside — merged in city dataset
  'outer sunset/parkside':          'Sunset/Parkside',
  'outer sunset':                   'Sunset/Parkside',
  'parkside':                       'Sunset/Parkside',
  // Cole Valley, Dogpatch, Crocker Amazon — not in city dataset, map to nearest
  'cole valley':                    'Haight Ashbury',
  'dogpatch':                       'Potrero Hill',
  'crocker amazon':                 'Excelsior',
  // NOPA and Cow Hollow — not in city dataset, map to nearest
  'lone mountain/usf':              'Lone Mountain/NOPA',
  'lone mountain':                  'Lone Mountain/NOPA',
  'nopa':                           'Lone Mountain/NOPA',
  'cow hollow':                     'Marina',
  // West Portal/Forest Hill — city dataset calls this area "West of Twin Peaks"
  'west of twin peaks':             'West Portal/Forest Hill',
  'west portal':                    'West Portal/Forest Hill',
  'forest hill':                    'West Portal/Forest Hill',
  // South of Market
  'soma':                           'South of Market',
  // Mission
  'the mission':                    'Mission',
  'mission district':               'Mission',
  // Haight
  'haight':                         'Haight Ashbury',
  'haight-ashbury':                 'Haight Ashbury',
  // Western Addition (Fillmore is the common name for this area)
  'fillmore':                       'Western Addition',
  // Marina
  'marina district':                'Marina',
  // Pacific Heights
  'pac heights':                    'Pacific Heights',
  'pacific hts':                    'Pacific Heights',
  // Potrero
  'potrero':                        'Potrero Hill',
  // Bernal Heights
  'bernal':                         'Bernal Heights',
};

function normalizeSfNeighborhood(name) {
  return SF_NBHD_ALIASES[name.toLowerCase()] ?? name;
}
