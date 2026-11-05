/* ============================================================
   cg-insights.js — Community Group insights page (/cg/CODE)
   One screen of what the group shares, from that roster's survey
   answers only, plus a running list of who has joined. Live over SSE.
   ============================================================ */

'use strict';

const CODE = decodeURIComponent(location.pathname.split('/')[2] || '').toUpperCase();
// ?demo: sample members join one by one, with their own sample answers; nothing is written anywhere
const DEMO = new URLSearchParams(location.search).has('demo');

// Rows per panel; the page is laid out to fit one TV screen
const ROWS = { hearts: 8, skills: 6 };

// An icon per survey vocation; write-ins ("Other: …") get the fallback
const SKILL_ICONS = {
  'AI & Data': '🤖',
  'Arts, Media & Design': '🎨',
  'Business & Finance': '💼',
  'Caregiving & Home': '🏡',
  'Church & Ministry': '⛪',
  'Education': '📚',
  'Engineering (hardware, civil, mechanical)': '⚙️',
  'Healthcare & Mental Health': '🩺',
  'Hospitality & Food': '🍽️',
  'Law, Government & Policy': '⚖️',
  'Nonprofit & Social Services': '🤝',
  'Science & Research': '🔬',
  'Software & Product': '💻',
  'Student': '🎓',
  'Trades, Construction & Real Estate': '🔧',
};
const SKILL_ICON_FALLBACK = '✨';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  document.title = `${CODE} — Neighbors & Nations`;
  const join = document.getElementById('join');
  join.href = `/join/${encodeURIComponent(CODE)}`;
  const qr = document.getElementById('join-qr');
  qr.src = `/api/groups/${encodeURIComponent(CODE)}/qr.svg`;
  qr.alt = `QR code to join group ${CODE}`;
  document.getElementById('join-code').textContent = CODE;

  // The cloud and map are drawn to their panels' size, so redraw when that changes
  new ResizeObserver(() => lastHearts && renderCloud(lastHearts)).observe(document.getElementById('hearts'));
  new ResizeObserver(() => lastState && renderMap(lastState)).observe(document.getElementById('map'));
  loadMap();

  if (DEMO) return runDemo();

  fetch(`/api/groups/${encodeURIComponent(CODE)}/state`)
    .then(r => r.ok ? r.json() : r.json().then(d => Promise.reject(d)))
    .then(render)
    .catch(d => showMissing(d?.error));

  const events = new EventSource(`/api/events?group=${encodeURIComponent(CODE)}`);
  events.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'state' && msg.group) render(msg);
    if (msg.type === 'error') setLive(false);
    if (msg.type === 'live') setLive(true);
  };
  events.onerror = () => setLive(false);
  events.onopen = () => setLive(true);
});

// ---------------------------------------------------------------------------
// Demo mode (/cg/CODE?demo): for previews and the CG night video
// ---------------------------------------------------------------------------
const DEMO_JOIN_MS = 2500;

async function runDemo() {
  const tag = document.createElement('div');
  tag.id = 'demo-tag';
  tag.textContent = 'Demo: sample members and sample answers';
  document.body.append(tag);

  let joined = 0;
  const step = async () => {
    const state = await fetch(`/api/groups/${encodeURIComponent(CODE)}/demo?joined=${joined}`).then(r => r.json());
    if (joined === 0 && state.group.groupName === 'Sunset CG') {
      document.getElementById('join-qr').src = '/api/qr/survey.svg'; // no such group: any scannable code will do
    }
    render(state);
    if (joined++ < state.demoTotal) setTimeout(step, DEMO_JOIN_MS);
  };
  step();
}

function showMissing(message) {
  document.getElementById('group-name').textContent = CODE || 'No group code';
  const notice = document.getElementById('notice');
  notice.textContent = message || "We couldn't find that group code.";
  notice.hidden = false;
}

function setLive(ok) {
  document.getElementById('live-dot').classList.toggle('off', !ok);
  document.getElementById('live-label').textContent = ok ? 'Live' : 'Reconnecting';
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function render(state) {
  const g = state.group;
  const n = state.totalPeople || 0;
  document.getElementById('group-name').textContent = `${g.groupName}: Our Heart for the World`;
  document.getElementById('join-step').textContent = `Join ${g.groupName}`;
  document.getElementById('answered').textContent = n;
  document.getElementById('answered-label').textContent =
    n === 1 ? 'person has shared their heart' : 'people have shared their heart';
  setLive(state.isLive !== false);
  renderWho(state.members || []);

  document.getElementById('notice').hidden = true;
  document.getElementById('insights').hidden = false;

  const hearts = rankLabels(state.heartbeatCounts);
  const skills = rankLabels(state.vocationCounts);

  renderCloud(hearts.slice(0, ROWS.hearts));
  lastState = state;
  renderMap(state);
  renderBars('skills', skills.slice(0, ROWS.skills), 'No vocations shared yet', name => SKILL_ICONS[name] ?? SKILL_ICON_FALLBACK);
}

/** {label: {count, total}} → [{name, count, pct}] by count; total = people who answered that question */
function rankLabels(counts) {
  return Object.entries(counts || {})
    .filter(([name]) => name !== 'Other')
    .map(([name, { count, total }]) => ({ name, count, pct: pctOf(count, total) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function pctOf(count, total) {
  return total > 0 ? Math.round((count / total) * 100) : 0;
}

function renderBars(id, items, emptyText, iconFor = null) {
  const el = document.getElementById(id);
  if (!items.length) { el.innerHTML = `<p class="empty">${emptyText}</p>`; return; }
  const max = Math.max(...items.map(i => i.pct), 1);
  el.classList.toggle('with-icons', !!iconFor);
  el.innerHTML = items.map(i => `
    <div class="bar-row">
      ${iconFor ? `<span class="bar-icon" aria-hidden="true">${iconFor(i.name)}</span>` : ''}
      <span class="bar-name">${esc(i.name)}</span>
      <span class="bar-pct">${i.pct}%</span>
      <i style="width:${Math.max(3, (i.pct / max) * 100)}%"></i>
    </div>`).join('');
}

// ---------------------------------------------------------------------------
// Heartbeat Cloud: one bubble per heartbeat, area by count, packed on a spiral
// ---------------------------------------------------------------------------
let lastHearts = null;
const SVGNS = 'http://www.w3.org/2000/svg';

function renderCloud(items) {
  lastHearts = items;
  const el = document.getElementById('hearts');
  if (!items.length) { el.innerHTML = '<p class="empty">No answers yet</p>'; return; }
  const { width: W, height: H } = el.getBoundingClientRect();
  if (W < 50 || H < 50) return;
  const nodes = packBubbles(items, W, H);
  const max = items[0].count;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H });
  svg.innerHTML = '<defs><filter id="glowSm" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4"/></filter></defs>';
  for (const n of nodes) {
    const i = n.count / max;
    const dim = i < 0.25; // only the smallest bubbles go dim
    const g = svgEl('g', { class: 'bub' + (dim ? ' dim' : ''), transform: `translate(${n.x.toFixed(1)} ${n.y.toFixed(1)})` });
    g.append(
      svgEl('circle', { r: n.r + 6, fill: heat(i), opacity: '.25', filter: 'url(#glowSm)' }),
      svgEl('circle', { r: n.r, fill: dim ? 'rgba(255,181,71,.18)' : heat(0.35 + 0.65 * i), stroke: dim ? 'rgba(255,181,71,.6)' : 'none', 'stroke-width': '1.5' }),
    );
    const lines = splitLabel(n.name);
    const longest = Math.max(...lines.map(x => x.length));
    // Largest size at which the longest line still fits inside the bubble
    const fs = Math.min(24, n.r / 3.2, (n.r * 1.6) / (longest * 0.62));
    const y0 = -(lines.length * fs * 1.08) / 2 + fs * 0.55;
    lines.forEach((ln, k) => g.append(svgEl('text', { y: (y0 + k * fs * 1.08).toFixed(1), 'font-size': fs.toFixed(1) }, ln)));
    g.append(svgEl('text', { class: 'c', y: (y0 + lines.length * fs * 1.08 + 2).toFixed(1), 'font-size': (fs * 1.12).toFixed(1) }, `${n.pct}%`));
    svg.append(g);
  }
  el.replaceChildren(svg);
}

/** Place each bubble at the first free spot on an outward spiral; shrink everything and retry if one won't fit. */
function packBubbles(items, W, H) {
  const max = Math.max(...items.map(d => d.count));
  let scale = 1;
  for (let attempt = 0; attempt < 40; attempt++, scale *= 0.93) {
    const rMax = Math.min(W, H) * 0.44 * scale;
    const rMin = Math.min(W, H) * 0.17 * scale;
    const nodes = items.map(d => ({ ...d, r: Math.max(rMin, rMax * Math.sqrt(d.count / max)) }));
    const placed = [];
    let ok = true;
    for (const n of nodes) {
      let found = false;
      for (let s = 0; s < 4000; s++) {
        const a = s * 0.28, rad = a * 2.1;
        const x = W / 2 + rad * Math.cos(a) * (W / H), y = H / 2 + rad * Math.sin(a);
        if (x - n.r < 2 || x + n.r > W - 2 || y - n.r < 2 || y + n.r > H - 2) continue;
        if (placed.every(p => Math.hypot(p.x - x, p.y - y) >= p.r + n.r + 4)) {
          n.x = x; n.y = y; placed.push(n); found = true; break;
        }
      }
      if (!found) { ok = false; break; }
    }
    if (ok) return placed;
  }
  return [];
}

/** Bubble labels: wrap at ~11 characters, at most 3 lines, keeping "&" with the word before it */
function splitLabel(s) {
  const width = Math.max(11, ...s.split(' ').map(w => w.length));
  const lines = [];
  for (const word of s.split(' ')) {
    const last = lines[lines.length - 1];
    if (last != null && (last + ' ' + word).length <= width) lines[lines.length - 1] = last + ' ' + word;
    else if (word === '&' && last != null) lines[lines.length - 1] = last + ' &';
    else lines.push(word);
  }
  return lines.length > 3 ? [lines[0], lines[1], lines.slice(2).join(' ')] : lines;
}

/** Ember scale: deep brown → orange → pale gold */
function heat(i) {
  const a = [138, 70, 30], b = [255, 122, 61], c = [255, 219, 130];
  const mix = (x, y, t) => x.map((v, k) => Math.round(v + (y[k] - v) * t));
  return `rgb(${(i < 0.5 ? mix(a, b, i * 2) : mix(b, c, (i - 0.5) * 2)).join(',')})`;
}

function svgEl(tag, attrs, text) {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (text != null) n.textContent = text;
  return n;
}

// ---------------------------------------------------------------------------
// World map, coloured the way the main dashboard does it (countries only, no
// ocean outline): countries light up by how many of us named them, tiny lit
// countries get a glowing marker, and cities are small dots sized to the map
// ---------------------------------------------------------------------------
let lastState = null;
let mapFeatures = null;
let shapeToCountry = {};
let numToCountry = {};
const TINY_COUNTRY_AREA_PX = 12;

async function loadMap() {
  try {
    const [topo, countries] = await Promise.all([
      fetch('/data/world-50m.topo.json').then(r => r.json()),
      fetch('/data/countries.json').then(r => r.json()),
    ]);
    for (const c of countries) {
      if (c.num) numToCountry[c.num] = c.name;
      for (const shape of c.shapes || []) shapeToCountry[shape] = c.name;
    }
    // No one lives in Antarctica; leaving it out gives the rest of the world more room
    mapFeatures = topojson.feature(topo, topo.objects.countries).features.filter(f => f.properties?.name !== 'Antarctica');
    if (lastState) renderMap(lastState);
  } catch (e) {
    console.error('[cg] map failed to load:', e);
  }
}

function countryOf(f) {
  return shapeToCountry[f.properties?.name] || (f.id != null ? numToCountry[String(f.id).padStart(3, '0')] : undefined);
}

/** Same scale as the dashboard's countryFill */
function countryFill(count, maxCount) {
  if (!count) return 'hsl(35, 80%, 8%)';
  return `hsl(35, 90%, ${(8 + 52 * Math.sqrt(count / maxCount)).toFixed(1)}%)`;
}

function renderMap(state) {
  const el = document.getElementById('map');
  if (!mapFeatures || !window.d3) return;
  const { width: W, height: H } = el.getBoundingClientRect();
  if (W < 50 || H < 50) return;

  const countryPicks = state.countryPicks || {};
  const maxCountry = Math.max(1, ...Object.values(countryPicks));
  const projection = d3.geoNaturalEarth1().fitSize([W, H], { type: 'FeatureCollection', features: mapFeatures });
  const path = d3.geoPath(projection);

  const svg = d3.create('svg').attr('width', W).attr('height', H);
  svg.append('g').selectAll('path').data(mapFeatures).join('path')
    .attr('class', f => 'country-path' + (countryPicks[countryOf(f)] ? ' lit' : ''))
    .attr('d', path)
    .attr('fill', f => countryFill(countryPicks[countryOf(f)], maxCountry));

  // Lit countries too small to see get a marker on their largest shape
  const largest = new Map();
  for (const f of mapFeatures) {
    const name = countryOf(f);
    if (!name || !countryPicks[name]) continue;
    const area = path.area(f);
    if (!largest.has(name) || area > largest.get(name).area) largest.set(name, { f, area });
  }
  const markers = svg.append('g');
  for (const { f, area } of largest.values()) {
    if (area >= TINY_COUNTRY_AREA_PX) continue;
    const [cx, cy] = path.centroid(f);
    if (!isNaN(cx)) markers.append('circle').attr('class', 'country-marker').attr('cx', cx).attr('cy', cy).attr('r', 3.5);
  }

  // City dots: ~3px to ~7px on a 1440px-wide map, scaled with the map
  const k = W / 1440;
  const minArea = Math.PI * (3 * k) ** 2, maxArea = Math.PI * (7 * k) ** 2;
  const cities = state.cityPicks || [];
  const maxCity = Math.max(1, ...cities.map(c => c.count || 0));
  svg.append('g').selectAll('circle').data(cities.filter(c => c.lat && c.lng)).join('circle')
    .attr('class', 'city-dot')
    .attr('cx', c => projection([c.lng, c.lat])[0])
    .attr('cy', c => projection([c.lng, c.lat])[1])
    .attr('r', c => Math.sqrt((minArea + (maxArea - minArea) * (c.count / maxCity)) / Math.PI));
  el.replaceChildren(svg.node());
}

/** Running list of who has joined, newest first; new arrivals fade in. */
let knownEmails = null;
function renderWho(members) {
  document.getElementById('who-count').textContent = members.length ? `(${members.length})` : '';
  const isNew = e => knownEmails && !knownEmails.has(e);
  document.getElementById('who-list').innerHTML = members.length
    ? members.map(m => `<li class="${isNew(m.email) ? 'fresh' : ''}">${esc(m.email || 'Joined earlier')}</li>`).join('')
    : '<li class="empty">No one yet. Scan the code to join.</li>';
  knownEmails = new Set(members.map(m => m.email));
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
