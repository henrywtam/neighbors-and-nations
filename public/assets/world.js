/* ============================================================
   world.js — world map, leaderboard, SSE client
   ============================================================ */

'use strict';

// ---------------------------------------------------------------------------
// Country name → ISO numeric code mapping
// Covers all countries from geonames.js countryNameToCode (~85 entries) plus extras
// ---------------------------------------------------------------------------
const COUNTRY_NAME_TO_ISO_NUM = {
  'Afghanistan': '4',
  'Algeria': '12',
  'Angola': '24',
  'Argentina': '32',
  'Australia': '36',
  'Austria': '40',
  'Bangladesh': '50',
  'Belgium': '56',
  'Bolivia': '68',
  'Brazil': '76',
  'Burkina Faso': '854',
  'Cambodia': '116',
  'Cameroon': '120',
  'Canada': '124',
  'Chad': '148',
  'Chile': '152',
  'China': '156',
  'Colombia': '170',
  'Costa Rica': '188',
  'Croatia': '191',
  'Cuba': '192',
  'Czech Republic': '203',
  'Democratic Republic of Congo': '180',
  'Denmark': '208',
  'Dominican Republic': '214',
  'Ecuador': '218',
  'Egypt': '818',
  'El Salvador': '222',
  'Ethiopia': '231',
  'Finland': '246',
  'France': '250',
  'Germany': '276',
  'Ghana': '288',
  'Greece': '300',
  'Guatemala': '320',
  'Haiti': '332',
  'Honduras': '340',
  'Hungary': '348',
  'India': '356',
  'Indonesia': '360',
  'Iran': '364',
  'Iraq': '368',
  'Israel': '376',
  'Italy': '380',
  'Jamaica': '388',
  'Japan': '392',
  'Jordan': '400',
  'Kenya': '404',
  'Laos': '418',
  'Lebanon': '422',
  'Libya': '434',
  'Madagascar': '450',
  'Malaysia': '458',
  'Mali': '466',
  'Mexico': '484',
  'Morocco': '504',
  'Mozambique': '508',
  'Myanmar': '104',
  'Nepal': '524',
  'Netherlands': '528',
  'New Zealand': '554',
  'Nicaragua': '558',
  'Niger': '562',
  'Nigeria': '566',
  'Norway': '578',
  'Pakistan': '586',
  'Panama': '591',
  'Peru': '604',
  'Philippines': '608',
  'Poland': '616',
  'Portugal': '620',
  'Romania': '642',
  'Russia': '643',
  'Rwanda': '646',
  'Saudi Arabia': '682',
  'Senegal': '686',
  'Serbia': '688',
  'Singapore': '702',
  'South Africa': '710',
  'South Korea': '410',
  'South Sudan': '728',
  'Spain': '724',
  'Sri Lanka': '144',
  'Sudan': '729',
  'Sweden': '752',
  'Switzerland': '756',
  'Syria': '760',
  'Tanzania': '834',
  'Thailand': '764',
  'Tunisia': '788',
  'Turkey': '792',
  'Uganda': '800',
  'Ukraine': '804',
  'United Arab Emirates': '784',
  'United Kingdom': '826',
  'United States': '840',
  'Venezuela': '862',
  'Vietnam': '704',
  'Zambia': '894',
  'Zimbabwe': '716',
};

// Reverse: ISO numeric string → country name
const ISO_NUM_TO_COUNTRY_NAME = Object.fromEntries(
  Object.entries(COUNTRY_NAME_TO_ISO_NUM).map(([name, num]) => [num, name])
);

// ---------------------------------------------------------------------------
// Ocean leaderboard anchor positions [lon, lat]
// Cities (left) and Regions (right) share the same latitude so they sit
// at the same vertical level. Countries sits lower in the South Atlantic.
// ---------------------------------------------------------------------------
const OCEAN_LB_POSITIONS = {
  'olb-cities':    [-110, -12],  // South Pacific (left)
  'olb-countries': [-10, -12],   // South Atlantic (centre)
  'olb-regions':   [82, -12],    // Indian Ocean (right)
};

// ---------------------------------------------------------------------------
// SF: maps each GeoJSON feature name → canonical name used in sfNeighborhoodCounts.
// Polygons that share a canonical name all glow with the combined count.
// ---------------------------------------------------------------------------
// Maps GeoJSON feature names → canonical names stored in sfNeighborhoodCounts.
// Only needed where the GeoJSON name differs from what the processor stores.
const SF_GEO_TO_CANONICAL = {
  'West of Twin Peaks':  'West Portal/Forest Hill',
  'Lone Mountain/USF':   'Lone Mountain/NOPA',
};

// Manual label position offsets [dx, dy] in SVG pixels for awkward centroids.
const SF_LABEL_OFFSETS = {
  'West of Twin Peaks': [0, -20],
};

// Parks and non-residential areas: show name label but hide the count.
const SF_NO_COUNT = new Set(['Golden Gate Park', 'McLaren Park', 'Presidio', 'Lincoln Park']);

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
const TAB_ROTATE_MS = 8000;

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
});

// ---------------------------------------------------------------------------
// SSE connection
// ---------------------------------------------------------------------------
function setupSSE() {
  const evtSource = new EventSource('/api/events');
  evtSource.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'state') handleStateMessage(msg);
    if (msg.type === 'error') showReconnecting();
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
    const res = await fetch('/data/world-50m.topo.json');
    topoData = await res.json();
    countryFeatures = topojson.feature(topoData, topoData.objects.countries).features;
    // Filter out Antarctica (ISO 010)
    countryFeatures = countryFeatures.filter(f => String(f.id) !== '10');
    initMap();
    if (currentState) renderMap(currentState, null);
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
  renderCountries(state, prevState);
  renderRegions(state, prevState);
  renderCities(state, prevState);
  renderOceanLeaderboards(state);
}

// ---------------------------------------------------------------------------
// Country colors
// ---------------------------------------------------------------------------
function countryFill(countryName, isSelectable, countryPicks, maxCount) {
  const count = isSelectable ? (countryPicks[countryName] || 0) : 0;
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

  const selectableNames = new Set(Object.keys(COUNTRY_NAME_TO_ISO_NUM));
  const g = svg.select('g.countries');

  const paths = g.selectAll('path.country-path')
    .data(countryFeatures, d => d.id);

  // Enter
  paths.enter()
    .append('path')
    .attr('class', 'country-path')
    .attr('d', pathGen)
    .each(function(d) {
      const name = ISO_NUM_TO_COUNTRY_NAME[String(d.id)];
      const isSelectable = !!(name && selectableNames.has(name));
      const fill = countryFill(name, isSelectable, countryPicks, maxCount);
      d3.select(this)
        .attr('fill', fill)
        .attr('stroke', 'rgba(255,255,255,0.05)')
        .attr('stroke-width', 0.4);
    });

  // Update existing
  g.selectAll('path.country-path')
    .each(function(d) {
      const name = ISO_NUM_TO_COUNTRY_NAME[String(d.id)];
      const isSelectable = !!(name && selectableNames.has(name));
      if (!isSelectable) return;

      const prevCount = prevState ? ((prevState.countryPicks && prevState.countryPicks[name]) || 0) : 0;
      const newCount = countryPicks[name] || 0;

      const fill = countryFill(name, isSelectable, countryPicks, maxCount);
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

  // Build a lookup: ISO numeric id → whether it belongs to a region's country list
  // For each region, find matching feature IDs
  const regionFeatureGroups = {};
  for (const [regionName, countries] of Object.entries(regionCountries)) {
    const ids = new Set(countries.map(c => COUNTRY_NAME_TO_ISO_NUM[c]).filter(Boolean));
    regionFeatureGroups[regionName] = countryFeatures.filter(f => ids.has(String(f.id)));
  }

  const g = svg.select('g.regions');
  const gl = svg.select('g.region-labels');

  // Remove old
  g.selectAll('*').remove();
  gl.selectAll('*').remove();

  for (const regionName of regionNames) {
    const features = regionFeatureGroups[regionName] || [];
    if (features.length === 0) continue;

    const count = Number(regionPicks[regionName]) || 0;
    const prevCount = prevState ? (Number((prevState.regionPicks || {})[regionName]) || 0) : 0;

    const strokeWidth = 1.5 + 3 * Math.sqrt(count / maxRegionCount);
    const strokeColor = (prevState && count > prevCount) ? '#ffffff' : '#00e5c8';

    // Merge country geometries for this region
    let mergedPath;
    try {
      const merged = topojson.merge(topoData, features);
      mergedPath = pathGen(merged);
    } catch (e) {
      continue;
    }

    const path = g.append('path')
      .attr('class', 'region-outline')
      .attr('d', mergedPath)
      .attr('stroke', strokeColor)
      .attr('stroke-width', strokeWidth);

    // Animate back to teal if we just changed
    if (prevState && count > prevCount) {
      path.transition().duration(1000).attr('stroke', '#00e5c8');
    }

    // Region label
    if (count > 0) {
      renderRegionLabel(gl, regionName, count);
    }
  }
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
  const minDotArea = 1;
  const maxDotArea = 50;
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
  }
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
  const sfBayCount = state.sfBayCount || 0;

  const items = [];

  for (const [name, count] of Object.entries(countryPicks)) {
    items.push({ name, count, type: 'country' });
  }
  for (const [name, count] of Object.entries(regionPicks)) {
    items.push({ name, count, type: 'region' });
  }
  if (sfBayCount > 0) {
    items.push({ name: 'SF & Bay Area', count: sfBayCount, type: 'sfbay' });
  }

  items.sort((a, b) => b.count - a.count);
  const top = items.slice(0, 10);
  const maxCount = top.length > 0 ? top[0].count : 1;

  renderRankedList(list, top, total, maxCount);
}

function renderHeartbeatList(state, total) {
  const list = document.getElementById('lb-heartbeats');
  if (!list) return;

  const heartbeatCounts = state.heartbeatCounts || {};
  const items = Object.entries(heartbeatCounts)
    .map(([name, val]) => ({ name, count: val.count || val, type: 'heartbeat' }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const maxCount = items.length > 0 ? items[0].count : 1;
  renderRankedList(list, items, total, maxCount);
}

function renderVocationList(state, total) {
  const list = document.getElementById('lb-vocations');
  if (!list) return;

  const vocationCounts = state.vocationCounts || {};
  const items = Object.entries(vocationCounts)
    .map(([name, val]) => ({ name, count: val.count || val, type: 'vocation' }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const maxCount = items.length > 0 ? items[0].count : 1;
  renderRankedList(list, items, total, maxCount);
}

function renderRankedList(container, items, total, maxCount) {
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

    const row = document.createElement('div');
    row.className = `lb-row type-${item.type}`;
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
      .slice(0, 5);
    cEl.style.display = items.length === 0 ? 'none' : '';
    cEl.innerHTML = renderOceanCard('Countries', items);
  }

  // Cities
  const ciEl = document.getElementById('olb-cities');
  if (ciEl) {
    const items = ((state && state.cityPicks) || [])
      .slice()
      .sort((a, b) => (b.count || 0) - (a.count || 0))
      .slice(0, 5)
      .map(c => ({ name: c.name, count: c.count }));
    ciEl.style.display = items.length === 0 ? 'none' : '';
    ciEl.innerHTML = renderOceanCard('Cities', items);
  }

  // Regions
  const rEl = document.getElementById('olb-regions');
  if (rEl) {
    const sfBayCount = (state && state.sfBayCount) || 0;
    const items = [
      ...Object.entries((state && state.regionPicks) || {}).map(([name, count]) => ({ name, count })),
      ...(sfBayCount > 0 ? [{ name: 'SF / Bay Area', count: sfBayCount }] : []),
    ].sort((a, b) => b.count - a.count).slice(0, 5);
    rEl.style.display = items.length === 0 ? 'none' : '';
    rEl.innerHTML = renderOceanCard('Regions', items);
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
function setupAppTabs() {
  document.querySelectorAll('.app-tab').forEach(btn => {
    btn.addEventListener('click', async () => {
      const view = btn.dataset.view;
      if (view === currentView) return;
      currentView = view;
      document.querySelectorAll('.app-tab').forEach(b => {
        b.classList.toggle('active', b.dataset.view === view);
      });
      document.querySelectorAll('.app-view').forEach(v => {
        v.classList.toggle('active', v.id === `${view}-view`);
      });
      if (view === 'sf') {
        if (!sfGeoData) {
          try { await loadSfGeo(); } catch (e) { console.error('[sf] GeoJSON load failed:', e); return; }
        }
        initSfMap();
      }
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

    // Fit with padding so edge neighborhoods (Outer Sunset, Bayview, etc.) aren't clipped
    const pad = 24;
    sfProjection = d3.geoMercator().fitExtent([[pad, pad], [w - pad, h - pad]], sfGeoData);
    sfPathGen = d3.geoPath().projection(sfProjection);

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
  const maxCount = Math.max(1, ...Object.values(sfCounts).map(Number));
  const features = sfGeoData.features || [];

  g.selectAll('*').remove();

  // Pass 1: draw all polygon fills and borders
  for (const feature of features) {
    const geoName   = feature.properties[sfNbhdNameKey] ?? '';
    const canonical = SF_GEO_TO_CANONICAL[geoName] ?? geoName;
    const count     = Number(sfCounts[canonical] || 0);

    const fill = count === 0
      ? 'hsl(35, 80%, 8%)'
      : `hsl(35, 90%, ${(38 + 27 * Math.sqrt(count / maxCount)).toFixed(1)}%)`;

    g.append('path')
      .attr('d', sfPathGen(feature))
      .attr('fill', fill)
      .attr('stroke', 'rgba(255,255,255,0.12)')
      .attr('stroke-width', 0.8);
  }

  // Pass 2: draw all labels on top of borders
  const labeledCanonical = new Set();
  for (const feature of features) {
    const geoName   = feature.properties[sfNbhdNameKey] ?? '';
    const canonical = SF_GEO_TO_CANONICAL[geoName] ?? geoName;
    const count     = Number(sfCounts[canonical] || 0);

    if (!labeledCanonical.has(canonical)) {
      labeledCanonical.add(canonical);
      const centroid = sfPathGen.centroid(feature);
      if (isNaN(centroid[0])) continue;
      const [dx, dy] = SF_LABEL_OFFSETS[canonical] ?? [0, 0];
      const noCount = SF_NO_COUNT.has(canonical);
      const lg = g.append('g').attr('transform', `translate(${centroid[0] + dx},${centroid[1] + dy})`);
      lg.append('text').attr('class', count > 0 ? 'sf-nbhd-label active' : 'sf-nbhd-label').attr('text-anchor', 'middle').attr('dy', noCount ? '0.3em' : '-0.3em').text(canonical);
      if (!noCount) lg.append('text').attr('class', count > 0 ? 'sf-nbhd-count active' : 'sf-nbhd-count').attr('text-anchor', 'middle').attr('dy', '1em').text(count);
    }
  }

  renderSfSidebar(state);
}

function renderSfSidebar(state) {
  const sfCounts = state.sfNeighborhoodCounts || {};
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
    return `<div class="lb-row">
      <span class="lb-rank">${i + 1}</span>
      <span class="lb-name">${escHtml(item.name)}</span>
      <span class="lb-meta"><span class="lb-count">${item.count}</span><span class="lb-pct">${pct}%</span></span>
      <div class="lb-bar-wrap"><div class="lb-bar" style="width:${barW}%"></div></div>
    </div>`;
  }).join('');
}
