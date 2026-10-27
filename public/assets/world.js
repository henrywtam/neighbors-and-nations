/* ============================================================
   world.js — world map, leaderboard, SSE client
   ============================================================ */

'use strict';

// ---------------------------------------------------------------------------
// Map shape → country name lookups, built from /data/countries.json
// (shared with the server). A shape matches by topojson name first — this
// covers territories rolled into a parent and shapes with no numeric id —
// then by zero-padded ISO numeric id.
// ---------------------------------------------------------------------------
let shapeNameToCountry = {};
let isoNumToCountry = {};
let alpha2ToCountry = {};

function buildCountryLookups(countries) {
  shapeNameToCountry = {};
  isoNumToCountry = {};
  alpha2ToCountry = {};
  for (const c of countries) {
    if (c.num) isoNumToCountry[c.num] = c.name;
    if (c.alpha2) alpha2ToCountry[c.alpha2] = c.name;
    for (const shape of c.shapes || []) shapeNameToCountry[shape] = c.name;
  }
}

function countryForFeature(f) {
  const shapeName = f.properties && f.properties.name;
  return shapeNameToCountry[shapeName]
    || (f.id != null ? isoNumToCountry[String(f.id).padStart(3, '0')] : undefined);
}

// ---------------------------------------------------------------------------
// Ocean leaderboard anchor positions [lon, lat]
// All three share one latitude so the cards sit in a horizontal row just
// south of the equator. Countries sits in the Atlantic gap between Brazil
// and Africa, so it's the tightest fit.
// ---------------------------------------------------------------------------
const OCEAN_LB_POSITIONS = {
  'olb-cities':    [-112, -20],  // South Pacific (left)
  'olb-countries': [-12, -20],   // South Atlantic (centre)
  'olb-regions':   [80, -20],    // Indian Ocean (right)
};

const OCEAN_LB_SIZE = 5;
// Heart outline for the heartbeat rank badges (24px icon grid)
const HEART_PATH = 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z';
// TV sidebar lists show everything that fits the screen height; rows past the bottom fade out.
// Desktop lists scroll, so they show every row.
const SIDEBAR_MAX_ROWS = 40;

// ---------------------------------------------------------------------------
// SF: maps each GeoJSON feature name → canonical name used in sfNeighborhoodCounts.
// Polygons that share a canonical name all glow with the combined count.
// ---------------------------------------------------------------------------
// Maps GeoJSON feature names → canonical names stored in sfNeighborhoodCounts.
// Only needed where the GeoJSON name differs from what the processor stores.
const SF_GEO_TO_CANONICAL = {
  'West of Twin Peaks':  'West Portal/Forest Hill',
  'Lone Mountain/USF':   'Lone Mountain/NOPA',
  'Outer Mission':       'Mission',  // not in the form dropdown; glows with Mission
};

// Manual label position offsets [dx, dy] in SVG pixels for awkward centroids.
const SF_LABEL_OFFSETS = {
  'West of Twin Peaks': [0, -20],
};

// Treasure Island sits far out in the bay, so fitting it shrinks the whole city.
// The map is fitted to the other neighborhoods and the island is drawn shifted
// down beside the waterfront.
const SF_INSET_FEATURE = 'Treasure Island';

// Parks: no one lives there, so they're drawn green with a name but no count.
const SF_PARKS = new Set(['Golden Gate Park', 'McLaren Park', 'Presidio', 'Lincoln Park']);
const SF_PARK_FILL = 'hsl(140, 25%, 14%)';

// ---------------------------------------------------------------------------
// SF local partner organizations (San Francisco locations only)
// ---------------------------------------------------------------------------
let sfPartnersVisible = false;

const SF_PARTNERS = [
  { name: 'Reality SF',                     address: 'Valencia St & 24th St',          lat: 37.7529, lng: -122.4194 },
  { name: 'BJM',                            address: '357 Ellis St (YWAM SF Building)', lat: 37.7833, lng: -122.4138 },
  { name: 'YWAM SF',                        address: '357 Ellis St',                    lat: 37.7831, lng: -122.4133 },
  { name: 'Buena Vista Horace Mann School', branch: 'Current Campus',        address: '325 La Grande Ave',           lat: 37.7186, lng: -122.4442 },
  { name: 'Buena Vista Horace Mann School', branch: 'Permanent Campus',      address: '3351 23rd St',                lat: 37.7515, lng: -122.4343 },
  { name: 'Rise University Preparatory',    address: '1224 Fairfax Ave',                lat: 37.7263, lng: -122.4550 },
  { name: 'SF-Marin Food Bank',              branch: 'SF Branch',             address: '900 Pennsylvania Ave',            lat: 37.7527, lng: -122.3945 },
  { name: 'Foster the City',                address: '1504 Bryant St',                  lat: 37.7697, lng: -122.4105 },
  { name: 'Jamestown Community Center',     address: '2929 19th St',                    lat: 37.7617, lng: -122.4135 },
  { name: 'Donum Dei Classical Academy',    address: '1560 Treat Ave',                  lat: 37.7565, lng: -122.4113 },
  { name: 'Dolores Street Community Services', address: '938 Valencia St',              lat: 37.7592, lng: -122.4214 },
  { name: 'Dolores Shelter Program',        address: '1050 South Van Ness Ave',         lat: 37.7565, lng: -122.4191 },
  { name: 'Richard Cohen Residence',        address: '220 Dolores St',                  lat: 37.7678, lng: -122.4256 },
  { name: 'SF Adult & Teen Challenge',      address: '1464 Valencia St',                lat: 37.7497, lng: -122.4204 },
  { name: 'Everett Middle School',          address: '450 Church St',                   lat: 37.7643, lng: -122.4290 },
  { name: 'Sanchez Elementary School',      address: '325 Sanchez St',                  lat: 37.7641, lng: -122.4310 },
  { name: 'John O\'Connell High School',    address: '2355 Folsom St',                  lat: 37.7541, lng: -122.4125 },
  { name: 'Mission Graduates',              address: '3040 16th St',                    lat: 37.7648, lng: -122.4205 },
  { name: 'New Door Ventures',              branch: 'New Door – SF',         address: '3221 20th St',                lat: 37.7588, lng: -122.4226 },
  { name: 'Old Skool Cafe',                 address: '1429 Mendell St',                 lat: 37.7355, lng: -122.3878 },
  { name: 'Sunset Youth Services',          branch: 'Main Office',           address: '3918 Judah St',               lat: 37.7611, lng: -122.5009 },
  { name: 'Sunset Youth Services',          branch: 'Family Support Center', address: 'Moraga St & 38th Ave',        lat: 37.7592, lng: -122.4985 },
  { name: 'Mobilize Love',                                                   address: 'Bernal Heights',              lat: 37.7360, lng: -122.4147 },
  { name: 'City Hope',                      address: '45 Olive St',                     lat: 37.7857, lng: -122.4176 },
  { name: 'City Impact',                    address: '230 Jones St',                    lat: 37.7836, lng: -122.4122 },
  { name: 'Open Door Legal',                branch: 'Bayview Branch',        address: '4634 3rd St',                 lat: 37.7257, lng: -122.3902 },
  { name: 'Open Door Legal',                branch: 'Excelsior Branch',      address: '60 Ocean Ave',                lat: 37.7237, lng: -122.4449 },
  { name: 'Open Door Legal',                branch: 'Western Addition Branch', address: '1113 Fillmore St',          lat: 37.7818, lng: -122.4327 },
  { name: 'Open Door Legal',                branch: 'Sunset Branch',         address: '1722 Irving St',              lat: 37.7638, lng: -122.4728 },
  { name: 'Alpha Pregnancy Center',         address: '5070 Mission St',                 lat: 37.7188, lng: -122.4407 },
];

// ---------------------------------------------------------------------------
// Config mirroring server config.js regionLabelPositions
// ---------------------------------------------------------------------------
const REGION_LABEL_POSITIONS = {
  'North America':           [-100, 60],
  'Latin America':           [-85, -25],
  'Africa':                  [25, -20],
  'Middle East':             [62, 15],
  'Eastern Europe & Russia': [85, 68],
  'Western Europe':          [-15, 52],
  'South & Central Asia':    [68, 5],
  'East & Southeast Asia':   [145, 10],
  'Pacific / Oceania':       [175, -30],
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let currentState = null;
let previousState = null;
let topoData = null;
let projection = null;
let pathGen = null;
let countryFeatures = [];
let svg = null;
let svgWidth = 0;
let svgHeight = 0;

// SF map state
let currentView = 'world';
let sfGeoData = null;
let sfSvg = null;
let sfProjection = null;
let sfPathGen = null;
let sfNbhdNameKey = 'nhood'; // GeoJSON property key for neighborhood name

let leaderboardTab = 0; // 0=Places, 1=Heart Issues, 2=Vocations
let tabRotateTimer = null;
const TAB_NAMES = ['Places', 'Heart Issues', 'Vocations'];
const TAB_ROTATE_MS = 5000;

// Display mode: 'tv' (room display at /tv, /tv/sf — no nav, rotating tabs, no hover) or
// 'desktop' (everything else — nav, scrollable/collapsible sidebar, map tooltips)
let displayMode = isTvPath(location.pathname) ? 'tv' : 'desktop';

function isTvPath(path) {
  return path === '/tv' || path.startsWith('/tv/');
}

function viewFromPath(path) {
  return path.replace(/^\/tv/, '') === '/sf' ? 'sf' : 'world';
}

function pathFor(mode, view) {
  return mode === 'tv' ? (view === 'sf' ? '/tv/sf' : '/tv') : `/${view}`;
}
const SIDEBAR_COLLAPSED_KEY = 'nn.sidebarCollapsed';

function applyDisplayMode() {
  document.body.classList.toggle('mode-tv', displayMode === 'tv');
  document.body.classList.toggle('mode-desktop', displayMode === 'desktop');
}
applyDisplayMode();

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  setupSSE();
  // Fetch current state immediately (don't wait for next SSE push)
  try {
    const res = await fetch('/api/state');
    if (res.ok) {
      const data = await res.json();
      data.type = 'state';
      handleStateMessage(data);
    }
  } catch (e) {
    console.warn('[world] initial fetch failed:', e);
  }

  await loadTopo();
  setupLeaderboardTabs();
  startTabRotation();
  setupResizeObserver();
  setupAppTabs();
  setupModeToggle();
  setupSidebarToggle();
});

// ---------------------------------------------------------------------------
// SSE connection
// ---------------------------------------------------------------------------
function setupSSE() {
  const evtSource = new EventSource('/api/events');
  evtSource.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    // Server pushes only when data changes; between pushes the cached state stays on screen
    if (msg.type === 'state') handleStateMessage(msg);
    if (msg.type === 'error') showReconnecting();
    if (msg.type === 'live') showLive();
  };
  evtSource.onerror = () => showReconnecting();
  evtSource.onopen = () => showLive();
}

function formatPulledTime(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (isNaN(d)) return '';
  return 'Updated ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function showLive() {
  const dot = document.getElementById('live-dot');
  const label = document.getElementById('live-label');
  const sfDot = document.getElementById('sf-live-dot');
  const sfLabel = document.getElementById('sf-live-label');
  if (dot) dot.classList.remove('reconnecting');
  if (label) label.textContent = 'Live';
  if (sfDot) sfDot.classList.remove('reconnecting');
  if (sfLabel) sfLabel.textContent = 'Live';
}

function showReconnecting() {
  const dot = document.getElementById('live-dot');
  const label = document.getElementById('live-label');
  const sfDot = document.getElementById('sf-live-dot');
  const sfLabel = document.getElementById('sf-live-label');
  if (dot) dot.classList.add('reconnecting');
  if (label) label.textContent = 'Reconnecting';
  if (sfDot) sfDot.classList.add('reconnecting');
  if (sfLabel) sfLabel.textContent = 'Reconnecting';
}

// ---------------------------------------------------------------------------
// TopoJSON loading
// ---------------------------------------------------------------------------
async function loadTopo() {
  try {
    const [topoRes, countriesRes] = await Promise.all([
      fetch('/data/world-50m.topo.json'),
      fetch('/data/countries.json'),
    ]);
    topoData = await topoRes.json();
    buildCountryLookups(await countriesRes.json());
    countryFeatures = topojson.feature(topoData, topoData.objects.countries).features;
    initMap();
    if (currentState) {
      renderMap(currentState, null);
      renderLeaderboard(currentState); // city labels need country names
    }
  } catch (e) {
    console.error('[world] Failed to load topo:', e);
  }
}

// ---------------------------------------------------------------------------
// Map initialization
// ---------------------------------------------------------------------------
function initMap() {
  const wrap = document.getElementById('map-svg-wrap');
  if (!wrap) return;
  const rect = wrap.getBoundingClientRect();
  svgWidth = rect.width || 900;
  svgHeight = rect.height || 500;

  // Remove existing SVG if any
  const existing = document.getElementById('map-svg');
  if (existing) existing.remove();
  hideMapTooltip();

  svg = d3.select('#map-svg-wrap')
    .append('svg')
    .attr('id', 'map-svg')
    .attr('width', svgWidth)
    .attr('height', svgHeight);

  // Define drop-shadow filter for lit countries
  const defs = svg.append('defs');
  const filter = defs.append('filter')
    .attr('id', 'amber-glow')
    .attr('x', '-30%').attr('y', '-30%')
    .attr('width', '160%').attr('height', '160%');
  filter.append('feGaussianBlur')
    .attr('in', 'SourceGraphic')
    .attr('stdDeviation', '3')
    .attr('result', 'blur');
  const feMerge = filter.append('feMerge');
  feMerge.append('feMergeNode').attr('in', 'blur');
  feMerge.append('feMergeNode').attr('in', 'SourceGraphic');


  projection = d3.geoNaturalEarth1()
    .fitSize([svgWidth, svgHeight], { type: 'Sphere' });

  pathGen = d3.geoPath().projection(projection);

  // Sphere background (ocean)
  svg.append('path')
    .datum({ type: 'Sphere' })
    .attr('class', 'sphere')
    .attr('d', pathGen);

  // Graticule
  const graticule = d3.geoGraticule()();
  svg.append('path')
    .datum(graticule)
    .attr('class', 'graticule')
    .attr('d', pathGen);

  // Country paths group
  svg.append('g').attr('class', 'countries');
  // Glow markers for lit countries too small to see at this scale
  svg.append('g').attr('class', 'country-markers');
  // Region outlines group
  svg.append('g').attr('class', 'regions');
  // City dots group
  svg.append('g').attr('class', 'cities');
  // Region labels group
  svg.append('g').attr('class', 'region-labels');

  // Render base countries (no data yet)
  renderCountries(null, null);

  // Position ocean leaderboard cards
  updateOceanLeaderboardPositions();
}

// ---------------------------------------------------------------------------
// Resize handling
// ---------------------------------------------------------------------------
function setupResizeObserver() {
  const worldWrap = document.getElementById('map-svg-wrap');
  if (worldWrap) {
    const ro = new ResizeObserver(() => {
      if (!topoData) return;
      initMap();
      if (currentState) renderMap(currentState, null);
    });
    ro.observe(worldWrap);
  }

  const sfWrap = document.getElementById('sf-map-wrap');
  if (sfWrap) {
    const ro = new ResizeObserver(() => {
      if (currentView === 'sf' && sfGeoData) initSfMap();
    });
    ro.observe(sfWrap);
  }
}

// ---------------------------------------------------------------------------
// Handle incoming state
// ---------------------------------------------------------------------------
function handleStateMessage(msg) {
  previousState = currentState;
  currentState = msg;

  updateHeader(msg);

  if (topoData && svg) {
    renderMap(msg, previousState);
  }

  renderLeaderboard(msg);

  if (currentView === 'sf' && sfSvg) renderSfMap(msg);

  if (msg.isLive) showLive();
  else showReconnecting();
}

// ---------------------------------------------------------------------------
// Header update
// ---------------------------------------------------------------------------
function updateHeader(state) {
  const el = document.getElementById('people-count');
  if (el) {
    const newVal = state.totalPeople || 0;
    if (el.textContent !== String(newVal)) {
      el.textContent = newVal;
      // Brief pulse animation
      el.style.transform = 'scale(1.2)';
      el.style.color = '#ffffff';
      setTimeout(() => {
        el.style.transform = 'scale(1)';
        el.style.color = '';
      }, 400);
    }
  }

  const pulledText = formatPulledTime(state.readAt);
  const worldPulled = document.getElementById('last-pulled');
  if (worldPulled) worldPulled.textContent = pulledText;
  const sfPulled = document.getElementById('sf-last-pulled');
  if (sfPulled) sfPulled.textContent = pulledText;
}

// ---------------------------------------------------------------------------
// Full render
// ---------------------------------------------------------------------------
function renderMap(state, prevState) {
  hideMapTooltip(); // hovered elements may be rebuilt underneath the pointer
  renderCountries(state, prevState);
  renderRegions(state, prevState);
  renderCities(state, prevState);
  renderOceanLeaderboards(state);
}

// ---------------------------------------------------------------------------
// Country colors
// ---------------------------------------------------------------------------
function countryFill(countryName, countryPicks, maxCount) {
  const count = countryName ? (countryPicks[countryName] || 0) : 0;
  if (count === 0) return 'hsl(35, 80%, 8%)'; // uniform dark baseline for all countries

  const minGlow = 8;
  const maxGlow = 60;
  const L = minGlow + (maxGlow - minGlow) * Math.sqrt(count / maxCount);
  return `hsl(35, 90%, ${L.toFixed(1)}%)`;
}

function renderCountries(state, prevState) {
  if (!svg) return;

  const countryPicks = state ? (state.countryPicks || {}) : {};

  // Compute max count for scaling
  let maxCount = 1;
  for (const cnt of Object.values(countryPicks)) {
    if (cnt > maxCount) maxCount = cnt;
  }

  const g = svg.select('g.countries');

  // Key by shape name: ids repeat (Australia/Ashmore) or are missing (Kosovo)
  const paths = g.selectAll('path.country-path')
    .data(countryFeatures, d => d.properties.name);

  // Enter
  paths.enter()
    .append('path')
    .attr('class', 'country-path')
    .attr('d', pathGen)
    .each(function(d) {
      const name = countryForFeature(d);
      const fill = countryFill(name, countryPicks, maxCount);
      d3.select(this)
        .attr('fill', fill)
        .attr('stroke', 'rgba(255,255,255,0.05)')
        .attr('stroke-width', 0.4);
    })
    .on('pointerenter pointermove', function(event, d) {
      const name = countryForFeature(d);
      const count = name && currentState ? ((currentState.countryPicks || {})[name] || 0) : 0;
      if (!count) return hideMapTooltip();
      d3.select(this).classed('hover', true);
      showMapTooltip(event, name, count, 'country');
    })
    .on('pointerleave', function() {
      d3.select(this).classed('hover', false);
      hideMapTooltip();
    });

  // Update existing
  g.selectAll('path.country-path')
    .each(function(d) {
      const name = countryForFeature(d);
      if (!name) return;

      const prevCount = prevState ? ((prevState.countryPicks && prevState.countryPicks[name]) || 0) : 0;
      const newCount = countryPicks[name] || 0;

      const fill = countryFill(name, countryPicks, maxCount);
      const el = d3.select(this);

      if (prevState && newCount > prevCount) {
        const isFirstLight = prevCount === 0 && newCount > 0;
        const peakColor = isFirstLight ? 'hsl(35, 100%, 70%)' : 'hsl(35, 100%, 55%)';
        const duration = isFirstLight ? 1800 : 1200;

        el.classed('pulse', true)
          .attr('fill', peakColor)
          .style('filter', 'drop-shadow(0 0 12px rgba(255,160,30,0.9))')
          .transition()
          .duration(duration)
          .attr('fill', fill)
          .style('filter', newCount > 0 ? 'drop-shadow(0 0 8px rgba(255,160,30,0.6))' : 'none')
          .on('end', function() { d3.select(this).classed('pulse', false); });
      } else {
        el.attr('fill', fill)
          .style('filter', newCount > 0 ? 'drop-shadow(0 0 8px rgba(255,160,30,0.6))' : 'none');
      }
    });

  renderCountryMarkers(countryPicks, prevState);
}

// ---------------------------------------------------------------------------
// Tiny-country markers — microstates and small islands are sub-pixel at this
// scale, so a lit one gets a glowing dot at the centroid of its largest shape.
// ---------------------------------------------------------------------------
const TINY_COUNTRY_AREA_PX = 12;

function renderCountryMarkers(countryPicks, prevState) {
  const g = svg.select('g.country-markers');
  g.selectAll('*').remove();

  // Largest on-screen shape per lit country
  const largest = new Map();
  for (const f of countryFeatures) {
    const name = countryForFeature(f);
    if (!name || !countryPicks[name]) continue;
    const area = pathGen.area(f);
    const cur = largest.get(name);
    if (!cur || area > cur.area) largest.set(name, { feature: f, area });
  }

  for (const [name, { feature, area }] of largest) {
    if (area >= TINY_COUNTRY_AREA_PX) continue;
    const [cx, cy] = pathGen.centroid(feature);
    if (isNaN(cx)) continue;

    const prevCount = prevState ? ((prevState.countryPicks && prevState.countryPicks[name]) || 0) : 0;
    const circle = g.append('circle')
      .attr('class', 'country-marker')
      .attr('cx', cx)
      .attr('cy', cy)
      .attr('r', 3.5)
      .on('pointerenter pointermove', (event) => showMapTooltip(event, name, countryPicks[name], 'country'))
      .on('pointerleave', hideMapTooltip);

    if (prevState && prevCount === 0) {
      circle.attr('r', 0)
        .transition()
        .duration(600)
        .ease(d3.easeBounceOut)
        .attr('r', 3.5);
    }
  }
}

// ---------------------------------------------------------------------------
// Region outlines
// ---------------------------------------------------------------------------
function renderRegions(state, prevState) {
  if (!svg || !topoData) return;

  const regionCountries = state ? (state.regionCountries || {}) : {};
  const regionPicks = state ? (state.regionPicks || {}) : {};

  const regionNames = Object.keys(regionCountries);
  const maxRegionCount = Math.max(1, ...Object.values(regionPicks).map(v => Number(v) || 0));

  svg.select('g.regions').selectAll('*').remove();
  svg.select('g.region-labels').selectAll('*').remove();
}

function renderRegionLabel(g, regionName, count) {
  const pos = REGION_LABEL_POSITIONS[regionName];
  if (!pos || !projection) return;

  const [lon, lat] = pos;
  const pt = projection([lon, lat]);
  if (!pt) return;
  const [x, y] = pt;

  const labelGroup = g.append('g')
    .attr('class', 'region-label-group')
    .attr('transform', `translate(${x},${y})`);

  labelGroup.append('text')
    .attr('class', 'region-label-text')
    .attr('text-anchor', 'middle')
    .attr('dy', '-0.2em')
    .text(regionName);

  labelGroup.append('text')
    .attr('class', 'region-label-count')
    .attr('text-anchor', 'middle')
    .attr('dy', '1.1em')
    .text(`${count} ${count === 1 ? 'person' : 'people'}`);
}

// ---------------------------------------------------------------------------
// City dots
// ---------------------------------------------------------------------------
function renderCities(state, prevState) {
  if (!svg || !projection) return;

  const cityPicks = state ? (state.cityPicks || []) : [];
  // Radius ~3px → ~7px on a 1440px-wide map, scaled with the map so dots stay
  // visible from across the room on big screens
  const k = svgWidth / 1440;
  const minDotArea = Math.PI * (3 * k) ** 2;
  const maxDotArea = Math.PI * (7 * k) ** 2;
  const maxCityCount = Math.max(1, ...cityPicks.map(c => c.count || 0));

  // Build set of previous cities by lat/lng key for new-city detection
  const prevCityKeys = new Set();
  if (prevState && prevState.cityPicks) {
    for (const c of prevState.cityPicks) {
      prevCityKeys.add(`${c.lat},${c.lng}`);
    }
  }

  const g = svg.select('g.cities');
  g.selectAll('*').remove();

  for (const city of cityPicks) {
    const { lat, lng, count, name } = city;
    if (!lat || !lng) continue;

    const pt = projection([lng, lat]);
    if (!pt) continue;
    const [cx, cy] = pt;

    const area = minDotArea + (maxDotArea - minDotArea) * (count / maxCityCount);
    const r = Math.sqrt(area / Math.PI);

    const key = `${lat},${lng}`;
    const isNew = prevState && !prevCityKeys.has(key);

    const circle = g.append('circle')
      .attr('class', 'city-dot')
      .attr('cx', cx)
      .attr('cy', cy)
      .attr('r', isNew ? 0 : r);

    if (isNew) {
      circle.transition()
        .duration(600)
        .ease(d3.easeBounceOut)
        .attr('r', r);
    }

    // Small dots are hard to hit, so hover a larger invisible circle on top
    g.append('circle')
      .attr('class', 'city-hit')
      .attr('cx', cx)
      .attr('cy', cy)
      .attr('r', Math.max(r + 3, 8))
      .on('pointerenter pointermove', (event) => {
        circle.classed('hover', true);
        showMapTooltip(event, cityLabel(city), count, 'city');
      })
      .on('pointerleave', () => {
        circle.classed('hover', false);
        hideMapTooltip();
      });
  }
}

// ---------------------------------------------------------------------------
// Map tooltip (desktop only) — name + count for lit countries and city dots
// ---------------------------------------------------------------------------
function showMapTooltip(event, name, count, type) {
  if (displayMode !== 'desktop') return;
  const tooltip = document.getElementById('map-tooltip');
  const wrap = document.getElementById('map-svg-wrap');
  if (!tooltip || !wrap) return;

  tooltip.className = `visible type-${type}`;
  tooltip.innerHTML = `<div class="mt-name">${escHtml(name)}</div>
    <div class="mt-count"><b>${count}</b> ${count === 1 ? 'person' : 'people'}</div>`;

  // Beside the pointer, flipped to the other side near the right/bottom edges
  const rect = wrap.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const margin = 14;
  let left = x + margin;
  let top = y + margin;
  if (left + tooltip.offsetWidth > rect.width - 8) left = x - tooltip.offsetWidth - margin;
  if (top + tooltip.offsetHeight > rect.height - 8) top = y - tooltip.offsetHeight - margin;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function hideMapTooltip() {
  const tooltip = document.getElementById('map-tooltip');
  if (tooltip) tooltip.className = '';
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------
function setupLeaderboardTabs() {
  const tabs = document.querySelectorAll('.lb-tab');
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => {
      clearTimeout(tabRotateTimer);
      setActiveTab(i);
      startTabRotation();
    });
  });
}

function startTabRotation() {
  clearTimeout(tabRotateTimer);
  if (displayMode !== 'tv') return; // desktop: tabs only change on click
  tabRotateTimer = setTimeout(() => {
    leaderboardTab = (leaderboardTab + 1) % TAB_NAMES.length;
    setActiveTab(leaderboardTab);
    startTabRotation();
  }, TAB_ROTATE_MS);
}

function setActiveTab(idx) {
  leaderboardTab = idx;
  document.querySelectorAll('.lb-tab').forEach((t, i) => {
    t.classList.toggle('active', i === idx);
  });
  document.querySelectorAll('.lb-list').forEach((l, i) => {
    l.classList.toggle('active', i === idx);
  });
}

function renderLeaderboard(state) {
  if (!state) return;

  const total = state.totalPeople || 0;

  // Update total count
  const lbTotal = document.getElementById('leaderboard-total');
  if (lbTotal) {
    const numEl = lbTotal.querySelector('.lb-total-num');
    if (numEl) numEl.textContent = total;
  }

  renderPlacesList(state, total);
  renderHeartbeatList(state, total);
  renderVocationList(state, total);
}

function renderPlacesList(state, total) {
  const list = document.getElementById('lb-places');
  if (!list) return;

  const countryPicks = state.countryPicks || {};
  const regionPicks = state.regionPicks || {};

  const items = [];

  for (const [name, count] of Object.entries(countryPicks)) {
    items.push({ name, count, type: 'country' });
  }
  for (const [name, count] of Object.entries(regionPicks)) {
    items.push({ name, count, type: 'region' });
  }
  for (const c of state.cityPicks || []) {
    items.push({ name: cityLabel(c), count: c.count || 0, type: 'city' });
  }

  items.sort((a, b) => b.count - a.count);
  const top = items.slice(0, sidebarRowLimit());
  const maxCount = top.length > 0 ? top[0].count : 1;

  let prevCounts = null;
  if (previousState) {
    prevCounts = {};
    for (const [n, c] of Object.entries(previousState.countryPicks || {})) prevCounts[n] = c;
    for (const [n, c] of Object.entries(previousState.regionPicks || {})) prevCounts[n] = c;
    for (const c of previousState.cityPicks || []) prevCounts[cityLabel(c)] = c.count || 0;
  }
  renderRankedList(list, top, total, maxCount, prevCounts);
}

function sidebarRowLimit() {
  return displayMode === 'tv' ? SIDEBAR_MAX_ROWS : Infinity;
}

/** "Shanghai, China" — the country suffix also keeps cities distinct from same-named countries. */
function cityLabel(c) {
  const country = alpha2ToCountry[c.countryCode];
  return country ? `${c.name}, ${country}` : c.name;
}

function renderHeartbeatList(state, total) {
  const list = document.getElementById('lb-heartbeats');
  if (!list) return;

  const heartbeatCounts = state.heartbeatCounts || {};
  const items = Object.entries(heartbeatCounts)
    .map(([name, val]) => ({ name, count: val.count || val, type: 'heartbeat' }))
    .sort((a, b) => b.count - a.count)
    .slice(0, sidebarRowLimit());

  const maxCount = items.length > 0 ? items[0].count : 1;
  const prevCounts = previousState
    ? Object.fromEntries(Object.entries(previousState.heartbeatCounts || {}).map(([k, v]) => [k, v.count || v]))
    : null;
  renderRankedList(list, items, total, maxCount, prevCounts);
}

function renderVocationList(state, total) {
  const list = document.getElementById('lb-vocations');
  if (!list) return;

  const vocationCounts = state.vocationCounts || {};
  const items = Object.entries(vocationCounts)
    .map(([name, val]) => ({ name, count: val.count || val, type: 'vocation' }))
    .sort((a, b) => b.count - a.count)
    .slice(0, sidebarRowLimit());

  const maxCount = items.length > 0 ? items[0].count : 1;
  const prevCounts = previousState
    ? Object.fromEntries(Object.entries(previousState.vocationCounts || {}).map(([k, v]) => [k, v.count || v]))
    : null;
  renderRankedList(list, items, total, maxCount, prevCounts);
}

function renderRankedList(container, items, total, maxCount, prevCounts = null) {
  // Record old positions for FLIP animation
  const oldPositions = new Map();
  container.querySelectorAll('.lb-row[data-key]').forEach(el => {
    const rect = el.getBoundingClientRect();
    oldPositions.set(el.dataset.key, { top: rect.top, left: rect.left });
  });

  // Clear and rebuild
  container.innerHTML = '';

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const pct = total > 0 ? ((item.count / total) * 100).toFixed(0) : '0';
    const barWidth = maxCount > 0 ? (item.count / maxCount * 100).toFixed(1) : '0';

    const prevCount = prevCounts !== null ? (prevCounts[item.name] || 0) : null;
    const flashClass = prevCounts !== null
      ? (prevCount === 0 ? 'lb-row--new' : item.count > prevCount ? 'lb-row--flash' : '')
      : '';
    const row = document.createElement('div');
    row.className = `lb-row type-${item.type}${i < 3 ? ' top3' : ''}${flashClass ? ' ' + flashClass : ''}`;
    row.dataset.key = item.name;

    row.innerHTML = `
      <span class="lb-rank">${i + 1}</span>
      <span class="lb-name type-${item.type}">${escHtml(item.name)}</span>
      <span class="lb-meta">
        <span class="lb-count">${item.count}</span>
        <span class="lb-pct">${pct}%</span>
      </span>
      <div class="lb-bar-wrap">
        <div class="lb-bar" style="width: ${barWidth}%"></div>
      </div>
    `;

    container.appendChild(row);
  }

  // FLIP: animate from old positions
  container.querySelectorAll('.lb-row[data-key]').forEach(el => {
    const key = el.dataset.key;
    const old = oldPositions.get(key);
    if (!old) return;
    const newRect = el.getBoundingClientRect();
    const dy = old.top - newRect.top;
    const dx = old.left - newRect.left;
    if (Math.abs(dy) < 1 && Math.abs(dx) < 1) return;

    el.style.transform = `translate(${dx}px, ${dy}px)`;
    el.style.transition = 'none';
    // Force reflow
    el.offsetHeight; // eslint-disable-line no-unused-expressions
    el.style.transition = 'transform 0.5s ease';
    el.style.transform = '';

    el.addEventListener('transitionend', () => {
      el.style.transition = '';
      el.style.transform = '';
    }, { once: true });
  });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Ocean leaderboard positioning and rendering
// ---------------------------------------------------------------------------
function updateOceanLeaderboardPositions() {
  if (!projection) return;
  for (const [id, [lon, lat]] of Object.entries(OCEAN_LB_POSITIONS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    const pt = projection([lon, lat]);
    if (!pt) continue;
    el.style.left = `${pt[0]}px`;
    el.style.top = `${pt[1]}px`;
  }
}

function renderOceanLeaderboards(state) {
  updateOceanLeaderboardPositions();

  // Countries
  const cEl = document.getElementById('olb-countries');
  if (cEl) {
    const items = Object.entries((state && state.countryPicks) || {})
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, OCEAN_LB_SIZE);
    cEl.style.display = items.length === 0 ? 'none' : '';
    cEl.innerHTML = renderOceanCard('Top Countries', items);
  }

  // Cities
  const ciEl = document.getElementById('olb-cities');
  if (ciEl) {
    const items = ((state && state.cityPicks) || [])
      .slice()
      .sort((a, b) => (b.count || 0) - (a.count || 0))
      .slice(0, OCEAN_LB_SIZE)
      .map(c => ({ name: c.name, count: c.count }));
    ciEl.style.display = items.length === 0 ? 'none' : '';
    ciEl.innerHTML = renderOceanCard('Top Cities', items);
  }

  // Regions
  const rEl = document.getElementById('olb-regions');
  if (rEl) {
    const items = Object.entries((state && state.regionPicks) || {})
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, OCEAN_LB_SIZE);
    rEl.style.display = items.length === 0 ? 'none' : '';
    rEl.innerHTML = renderOceanCard('Top Regions', items);
  }

  // Heartbeats band
  const hEl = document.getElementById('heartbeat-band');
  if (hEl) {
    const items = Object.entries((state && state.heartbeatCounts) || {})
      .map(([name, val]) => ({ name, count: val.count || val }))
      .sort((a, b) => b.count - a.count)
      .slice(0, OCEAN_LB_SIZE);
    hEl.style.display = items.length === 0 ? 'none' : '';
    hEl.innerHTML = `
      <div class="hb-title">What's on our heart</div>
      <div class="hb-items">${items.map((item, i) => `
        <div class="hb-item hb-item--r${i + 1}">
          <span class="hb-rank"><svg viewBox="2 3 20 18.35" aria-hidden="true"><path d="${HEART_PATH}"/></svg><span>${i + 1}</span></span>
          <span class="hb-name">${escHtml(item.name)}</span>
        </div>`).join('')}
      </div>`;
  }
}

function renderOceanCard(title, items) {
  const rows = items.map((item, i) => `
    <div class="ocean-lb-row">
      <span class="ocean-lb-rank">${i + 1}</span>
      <span class="ocean-lb-name">${escHtml(item.name)}</span>
      <span class="ocean-lb-count">${item.count}</span>
    </div>`).join('');
  return `<div class="ocean-lb-title">${escHtml(title)}</div>${rows}`;
}

// ---------------------------------------------------------------------------
// App tab switching
// ---------------------------------------------------------------------------
function toggleSfPartners() {
  sfPartnersVisible = !sfPartnersVisible;
  const btn = document.getElementById('sf-partners-toggle');
  if (btn) btn.classList.toggle('active', sfPartnersVisible);
  if (currentState && sfSvg) renderSfMap(currentState);
}

async function switchView(view, pushHistory = true) {
  if (view === currentView) return;
  currentView = view;
  document.querySelectorAll('.app-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.view === view);
  });
  document.querySelectorAll('.app-view').forEach(v => {
    v.classList.toggle('active', v.id === `${view}-view`);
  });
  if (pushHistory) history.pushState({ view, mode: displayMode }, '', pathFor(displayMode, view));
  if (view === 'sf') {
    if (!sfGeoData) {
      try { await loadSfGeo(); } catch (e) { console.error('[sf] GeoJSON load failed:', e); return; }
    }
    initSfMap();
  }
}

function setupAppTabs() {
  const partnersBtn = document.getElementById('sf-partners-toggle');
  if (partnersBtn) partnersBtn.addEventListener('click', toggleSfPartners);

  document.querySelectorAll('.app-tab').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // Pathname-based routing: read on load, follow browser back/forward
  if (viewFromPath(location.pathname) === 'sf') switchView('sf', false);

  window.addEventListener('popstate', () => {
    setDisplayMode(isTvPath(location.pathname) ? 'tv' : 'desktop', false);
    switchView(viewFromPath(location.pathname), false);
  });
}

// ---------------------------------------------------------------------------
// Display mode switching (TV ⇄ desktop)
// ---------------------------------------------------------------------------
function setDisplayMode(mode, pushHistory = true) {
  if (mode === displayMode) return;
  displayMode = mode;
  applyDisplayMode();
  hideMapTooltip();
  if (pushHistory) history.pushState({ mode }, '', pathFor(mode, currentView));
  if (currentState) renderLeaderboard(currentState); // row limit differs per mode
  startTabRotation();
}

function setupModeToggle() {
  document.getElementById('mode-to-tv')?.addEventListener('click', () => setDisplayMode('tv'));
  document.getElementById('mode-to-desktop')?.addEventListener('click', () => setDisplayMode('desktop'));
}

// ---------------------------------------------------------------------------
// Sidebar collapse (desktop only) — shared by the world and SF sidebars,
// remembered per browser. The maps re-fit via their ResizeObservers.
// ---------------------------------------------------------------------------
function setupSidebarToggle() {
  let collapsed = false;
  try { collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'; } catch { /* storage unavailable */ }

  const apply = () => {
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    document.querySelectorAll('.sidebar-toggle').forEach(btn => {
      const label = collapsed ? 'Expand list' : 'Collapse list';
      btn.title = label;
      btn.setAttribute('aria-label', label);
      btn.setAttribute('aria-expanded', String(!collapsed));
    });
  };
  apply();

  document.querySelectorAll('.sidebar-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      collapsed = !collapsed;
      apply();
      try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch { /* storage unavailable */ }
    });
  });
}

// ---------------------------------------------------------------------------
// SF GeoJSON loading
// ---------------------------------------------------------------------------
async function loadSfGeo() {
  const res = await fetch('/data/sf-neighborhoods.geojson');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  sfGeoData = await res.json();
  // Detect property name for neighborhood name
  const first = sfGeoData.features?.[0]?.properties ?? {};
  if (first.nhood !== undefined) sfNbhdNameKey = 'nhood';
  else if (first.name !== undefined) sfNbhdNameKey = 'name';
  else sfNbhdNameKey = Object.keys(first)[0] ?? 'name';
}

// ---------------------------------------------------------------------------
// SF map init + render
// ---------------------------------------------------------------------------
let sfZoom = null;
let sfInsetOffset = [0, 0];

function sfFeatureName(feature) {
  return feature.properties[sfNbhdNameKey] ?? '';
}

/** Shift for Treasure Island: keep its x, slide it down so its top lines up with the city's top edge. */
function computeSfInsetOffset(mainland) {
  const island = sfGeoData.features.find(f => sfFeatureName(f) === SF_INSET_FEATURE);
  if (!island) return [0, 0];
  const [[, cityTop]] = sfPathGen.bounds({ type: 'FeatureCollection', features: mainland });
  const [[, islandTop]] = sfPathGen.bounds(island);
  return [0, cityTop - islandTop];
}

function sfOffsetFor(feature) {
  return sfFeatureName(feature) === SF_INSET_FEATURE ? sfInsetOffset : [0, 0];
}

/** Fill for a neighborhood: dark when empty, dim → bright gold as the count grows. */
function sfFill(count, maxCount) {
  if (count === 0) return 'hsl(35, 80%, 8%)';
  // Wide lightness range so 2 people and 13 people look clearly different
  const t = Math.pow(count / maxCount, 0.75);
  return `hsl(${(28 + 10 * t).toFixed(1)}, 90%, ${(17 + 45 * t).toFixed(1)}%)`;
}

function initSfMap() {
  const wrap = document.getElementById('sf-map-wrap');
  if (!wrap || !sfGeoData) return;

  // Defer one frame so the container is painted before we measure it
  requestAnimationFrame(() => {
    const rect = wrap.getBoundingClientRect();
    const w = rect.width || 800;
    const h = rect.height || 600;
    if (w === 0 || h === 0) return;

    const existing = document.getElementById('sf-map-svg');
    if (existing) existing.remove();

    sfSvg = d3.select('#sf-map-wrap').append('svg')
      .attr('id', 'sf-map-svg')
      .attr('width', w)
      .attr('height', h);

    // Fit with padding so edge neighborhoods (Outer Sunset, Bayview, etc.) aren't clipped.
    // Treasure Island is left out of the fit and moved in afterwards.
    const pad = 24;
    const mainland = sfGeoData.features.filter(f => sfFeatureName(f) !== SF_INSET_FEATURE);
    sfProjection = d3.geoMercator().fitExtent([[pad, pad], [w - pad, h - pad]],
      { type: 'FeatureCollection', features: mainland });
    sfPathGen = d3.geoPath().projection(sfProjection);
    sfInsetOffset = computeSfInsetOffset(mainland);

    // Zoom/pan container — zoom transforms go here, not on SVG root
    sfSvg.append('g').attr('class', 'sf-zoom-g');

    // D3 zoom: scroll to zoom, drag to pan, double-click to reset
    sfZoom = d3.zoom()
      .scaleExtent([0.8, 20])
      .on('zoom', (event) => {
        sfSvg.select('g.sf-zoom-g').attr('transform', event.transform);
      });
    sfSvg.call(sfZoom);
    sfSvg.on('dblclick.zoom', () => {
      sfSvg.transition().duration(500).call(sfZoom.transform, d3.zoomIdentity);
    });

    if (currentState) renderSfMap(currentState);
  });
}

function renderSfMap(state) {
  if (!sfSvg || !sfGeoData || !sfPathGen) return;

  const g = sfSvg.select('g.sf-zoom-g');
  if (g.empty()) return;

  const sfCounts = state.sfNeighborhoodCounts || {};
  const prevSfCounts = previousState ? (previousState.sfNeighborhoodCounts || {}) : {};
  const maxCount = Math.max(1, ...Object.values(sfCounts).map(Number));
  const features = sfGeoData.features || [];

  g.selectAll('*').remove();

  // Pass 1: draw all polygon fills and borders
  for (const feature of features) {
    const geoName   = sfFeatureName(feature);
    const canonical = SF_GEO_TO_CANONICAL[geoName] ?? geoName;
    const count     = Number(sfCounts[canonical] || 0);
    const prevCount = Number(prevSfCounts[canonical] || 0);
    const isPark = SF_PARKS.has(canonical);
    const didIncrease = !isPark && previousState !== null && count > prevCount;

    const fill = isPark ? SF_PARK_FILL : sfFill(count, maxCount);
    const [ox, oy] = sfOffsetFor(feature);

    const path = g.append('path')
      .attr('d', sfPathGen(feature))
      .attr('transform', ox || oy ? `translate(${ox},${oy})` : null)
      .attr('fill', didIncrease ? (prevCount === 0 ? 'hsl(35, 100%, 72%)' : 'hsl(35, 100%, 58%)') : fill)
      .attr('stroke', 'rgba(255,255,255,0.12)')
      .attr('stroke-width', 0.8);

    if (didIncrease) {
      path.transition().duration(prevCount === 0 ? 1800 : 1200).attr('fill', fill);
    }
  }

  // Label size follows the drawn map, so text keeps its proportions on a laptop or a TV
  const [[x0], [x1]] = sfPathGen.bounds(sfGeoData);
  const nameSize = Math.max(9, Math.min(15, (x1 - x0) * 0.0115));
  const countSize = nameSize * 1.1;

  // Partner dots go under the labels so they never hide a neighborhood name
  renderSfPartners(g);

  // Pass 2: draw all labels on top of borders
  // Label each canonical name once, on the polygon that carries that exact
  // name when there is one (e.g. "Mission" on Mission, not Outer Mission)
  const labeledCanonical = new Set();
  const labelOrder = [...features].sort((a, b) => {
    const exact = f => {
      const n = f.properties[sfNbhdNameKey] ?? '';
      return (SF_GEO_TO_CANONICAL[n] ?? n) === n ? 0 : 1;
    };
    return exact(a) - exact(b);
  });
  for (const feature of labelOrder) {
    const geoName   = feature.properties[sfNbhdNameKey] ?? '';
    const canonical = SF_GEO_TO_CANONICAL[geoName] ?? geoName;
    const count     = Number(sfCounts[canonical] || 0);

    if (!labeledCanonical.has(canonical)) {
      labeledCanonical.add(canonical);
      const centroid = sfPathGen.centroid(feature);
      if (isNaN(centroid[0])) continue;
      const [dx, dy] = SF_LABEL_OFFSETS[canonical] ?? [0, 0];
      const [ox, oy] = sfOffsetFor(feature);
      const noCount = SF_PARKS.has(canonical);
      const active = noCount ? ' park' : count > 0 ? ' active' : '';
      const lg = g.append('g').attr('transform', `translate(${centroid[0] + dx + ox},${centroid[1] + dy + oy})`);

      const name = lg.append('text')
        .attr('class', 'sf-nbhd-label' + active)
        .attr('text-anchor', 'middle')
        .style('font-size', `${nameSize}px`);
      // Long "A/B" names that overflow their neighborhood go on one line per part
      let lines = [canonical];
      name.text(canonical);
      const [[bx0], [bx1]] = sfPathGen.bounds(feature);
      if (canonical.includes('/') && name.node().getComputedTextLength() > (bx1 - bx0) * 0.9) {
        lines = canonical.split('/');
        name.text(null);
      }

      // Stack name lines and the count around the label point
      const lineH = nameSize * 1.1;
      const blockH = lines.length * lineH + (noCount ? 0 : countSize * 1.05);
      let y = -blockH / 2 + lineH / 2;
      if (lines.length > 1) {
        for (const line of lines) {
          name.append('tspan').attr('x', 0).attr('y', y).attr('dy', '0.35em').text(line);
          y += lineH;
        }
      } else {
        name.attr('y', y).attr('dy', '0.35em');
        y += lineH;
      }
      if (!noCount) {
        lg.append('text')
          .attr('class', 'sf-nbhd-count' + active)
          .attr('text-anchor', 'middle')
          .attr('y', y - lineH / 2 + countSize * 0.55)
          .attr('dy', '0.35em')
          .style('font-size', `${countSize}px`)
          .text(count);
      }
    }
  }

  renderSfSidebar(state);
}

function positionSfTooltip(tooltip, event, wrapRect) {
  const x = event.clientX - wrapRect.left;
  const y = event.clientY - wrapRect.top;
  const ttW = 220;
  const ttH = 68;
  const margin = 14;
  let left = x + margin;
  let top = y - ttH / 2;
  if (left + ttW > wrapRect.width - 8) left = x - ttW - margin;
  top = Math.max(4, Math.min(top, wrapRect.height - ttH - 4));
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function renderSfPartners(g) {
  if (!g || g.empty() || !sfProjection) return;

  const tooltip = document.getElementById('sf-partner-tooltip');
  if (!tooltip) return;

  if (!sfPartnersVisible) return;

  for (const partner of SF_PARTNERS) {
    const pt = sfProjection([partner.lng, partner.lat]);
    if (!pt) continue;
    const [cx, cy] = pt;

    const pg = g.append('g')
      .attr('class', 'sf-partner-g')
      .attr('data-cx', cx)
      .attr('data-cy', cy)
      .attr('transform', `translate(${cx},${cy})`);

    // Glow ring
    pg.append('circle').attr('class', 'sf-partner-ring').attr('r', 7);
    // Filled dot
    pg.append('circle').attr('class', 'sf-partner-dot').attr('r', 4);

    // Invisible enlarged hit target
    pg.append('circle')
      .attr('r', 10)
      .attr('fill', 'transparent')
      .attr('class', 'sf-partner-hit')
      .on('mouseenter', function(event) {
        const wrap = document.getElementById('sf-map-wrap');
        tooltip.innerHTML = `<div class="spt-name">${escHtml(partner.name)}</div>${partner.branch ? `<div class="spt-branch">${escHtml(partner.branch)}</div>` : ''}<div class="spt-addr">${escHtml(partner.address)}</div>`;
        tooltip.classList.add('visible');
        positionSfTooltip(tooltip, event, wrap.getBoundingClientRect());
        d3.select(this.parentNode).classed('sf-partner-g--hover', true);
      })
      .on('mousemove', function(event) {
        positionSfTooltip(tooltip, event, document.getElementById('sf-map-wrap').getBoundingClientRect());
      })
      .on('mouseleave', function() {
        tooltip.classList.remove('visible');
        d3.select(this.parentNode).classed('sf-partner-g--hover', false);
      });
  }
}

function renderSfSidebar(state) {
  const sfCounts = state.sfNeighborhoodCounts || {};
  const prevSfCounts = previousState ? (previousState.sfNeighborhoodCounts || {}) : {};
  const numEl = document.getElementById('sf-lb-num');
  const body = document.getElementById('sf-lb-body');

  const items = Object.entries(sfCounts)
    .map(([name, count]) => ({ name, count: Number(count) }))
    .filter(item => item.count > 0)
    .sort((a, b) => b.count - a.count);

  const total = items.reduce((sum, item) => sum + item.count, 0);
  if (numEl) numEl.textContent = total;
  if (!body) return;

  const maxCount = items.length > 0 ? items[0].count : 1;
  body.innerHTML = items.map((item, i) => {
    const pct = total > 0 ? ((item.count / total) * 100).toFixed(0) : '0';
    const barW = (item.count / maxCount * 100).toFixed(1);
    const prevCount = Number(prevSfCounts[item.name] || 0);
    const flashClass = previousState
      ? (prevCount === 0 ? 'lb-row--new' : item.count > prevCount ? 'lb-row--flash' : '')
      : '';
    return `<div class="lb-row${flashClass ? ' ' + flashClass : ''}">
      <span class="lb-rank">${i + 1}</span>
      <span class="lb-name">${escHtml(item.name)}</span>
      <span class="lb-meta"><span class="lb-count">${item.count}</span><span class="lb-pct">${pct}%</span></span>
      <div class="lb-bar-wrap"><div class="lb-bar" style="width:${barW}%"></div></div>
    </div>`;
  }).join('');
}
