import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { createSheetCache } from './sheet-cache.js';
import { processResponses } from './processor.js';
import * as geonames from './geonames.js';
import config from './config.js';
import { syncPlanningCenter } from './sync-pc.js';
import QRCode from 'qrcode';
import { createGroupStore, publicGroup, memberList } from './groups.js';
import { demoGroup, DEMO_MEMBER_COUNT } from './demo.js';

const FORM_ID = process.env.PLANNING_CENTER_FORM_ID ?? '1335453';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const PUBLIC_DIR = join(__dirname, '..', 'public');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {import('./processor.js').ProcessedState | null} */
let currentState = null;

/** @type {Set<import('express').Response>} */
const sseClients = new Set();
/** Community Group screens, by group code */
/** @type {Map<string, Set<import('express').Response>>} */
const groupSseClients = new Map();

/** @type {ReturnType<typeof createSheetCache> | null} */
let cache = null;
/** @type {ReturnType<typeof createGroupStore> | null} */
let groups = null;

/** Whether the last Sheets check succeeded (drives the Live/Reconnecting badge). */
let sheetsHealthy = true;
/** Last successful sheet check, changed or not — the dashboard shows it as "Updated …" */
let lastCheckedAt = null;

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

function serializeState(state) {
  if (!state) return null;
  return {
    ...state,
    countryPicks: Object.fromEntries(state.countryPicks),
    regionPicks: Object.fromEntries(state.regionPicks),
    regionCountries: state.regionCountries
      ? Object.fromEntries([...state.regionCountries.entries()])
      : {},
    heartbeatCounts: Object.fromEntries(
      [...state.heartbeatCounts.entries()].map(([k, v]) => [k, v])
    ),
    vocationCounts: Object.fromEntries(
      [...state.vocationCounts.entries()].map(([k, v]) => [k, v])
    ),
    readAt: state.readAt?.toISOString() ?? null,
    checkedAt: lastCheckedAt?.toISOString() ?? null,
  };
}

function pushSseEvent(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
  // Group screens get their own state; everything else (live, checked, error) is shared
  if (data.type !== 'state') {
    for (const set of groupSseClients.values()) for (const res of set) res.write(payload);
  }
}

// ---------------------------------------------------------------------------
// Community Groups
// ---------------------------------------------------------------------------

/** Results for one group's roster, plus who has joined. */
function groupState(g) {
  const info = publicGroup(g);
  const state = processResponses(cache.sheetData(), config, geonames, { emailKeys: groups.memberKeys(g.code) });
  // Who has joined, newest first
  const roster = memberList(g).map(m => ({ email: m.email }));
  return {
    type: 'state',
    ...serializeState({ ...state, isLive: sheetsHealthy }),
    group: info,
    members: roster,
  };
}

function pushGroupState(code) {
  const set = groupSseClients.get(code);
  const g = groups?.get(code);
  if (!set?.size || !g || !cache) return;
  const payload = `data: ${JSON.stringify(groupState(g))}\n\n`;
  for (const res of set) res.write(payload);
}

function pushAllGroupStates() {
  for (const code of groupSseClients.keys()) pushGroupState(code);
}

/** Base URL as the visitor sees it (Railway terminates TLS in front of us). */
function baseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function groupLinks(req, code) {
  const base = baseUrl(req);
  return {
    screen: `${base}/cg/${code}`,
    join: `${base}/join/${code}`,
  };
}

// ---------------------------------------------------------------------------
// Sheet → map
// ---------------------------------------------------------------------------

function rebuildState() {
  const newState = processResponses(cache.sheetData(), config, geonames);
  currentState = { ...newState, isLive: sheetsHealthy };
  pushSseEvent({ type: 'state', ...serializeState(currentState) });
  pushAllGroupStates();
}

function markHealthy(ok, err) {
  if (ok === sheetsHealthy) return;
  sheetsHealthy = ok;
  if (currentState) currentState = { ...currentState, isLive: ok };
  if (ok) {
    console.log('[index] Sheets reachable again.');
    pushSseEvent({ type: 'live' });
  } else {
    console.error('[index] Sheets check failed (keeping cached data):', err?.message);
    pushSseEvent({ type: 'error', message: 'reconnecting' });
  }
}

/**
 * Read Meta; fetch + render only if new rows arrived.
 * @returns {Promise<boolean>} false if the check failed (cache may be stale)
 */
async function checkSheet() {
  try {
    const changed = await cache.checkForUpdates();
    lastCheckedAt = new Date();
    markHealthy(true);
    if (changed) {
      console.log(`[index] Sheet has new rows (now ${cache.rowCount}).`);
      rebuildState();
    } else {
      pushSseEvent({ type: 'checked', checkedAt: lastCheckedAt.toISOString() });
    }
    return true;
  } catch (err) {
    markHealthy(false, err);
    return false;
  }
}

async function checkReference() {
  try {
    if (await cache.refreshReference()) {
      console.log('[index] Reference tabs changed.');
      rebuildState();
    }
  } catch (err) {
    console.error('[index] Reference tab read failed (keeping cached data):', err.message);
  }
}

// ---------------------------------------------------------------------------
// Planning Center → Sheet
// ---------------------------------------------------------------------------

// Serialize syncs so overlapping webhooks/polls can't append the same row twice
let syncChain = Promise.resolve();

function runPcSync(reason) {
  syncChain = syncChain.then(async () => {
    // The dedup set must include every row already written, so make sure the
    // cache is current first (one Meta read); never sync from a stale cache.
    if (!(await checkSheet())) {
      console.warn(`[index] PC sync (${reason}) skipped: Sheet not reachable.`);
      return;
    }
    try {
      const { newCount } = await syncPlanningCenter(process.env.SHEET_ID, cache);
      if (newCount > 0) {
        console.log(`[index] PC sync (${reason}): ${newCount} new submission(s) written to Sheets.`);
        await checkSheet(); // pick up the rows now rather than on the next tick
      }
    } catch (err) {
      console.error(`[index] PC sync error (${reason}):`, err.message);
    }
  });
  return syncChain;
}

// Coalesce bursts of webhook deliveries into one sync
let webhookTimer = null;
function scheduleWebhookSync() {
  clearTimeout(webhookTimer);
  webhookTimer = setTimeout(() => runPcSync('webhook'), 2000);
}

function verifyPcSignature(rawBody, signature) {
  if (!signature) return false;
  const expected = createHmac('sha256', config.pcWebhookSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True if any delivery in the webhook body is a submission for our form. */
function isOurFormSubmission(body) {
  for (const delivery of body?.data ?? []) {
    if (!String(delivery.attributes?.name ?? '').includes('form_submission.created')) continue;
    try {
      const payload = JSON.parse(delivery.attributes.payload);
      const formId = payload?.data?.relationships?.form?.data?.id;
      if (!formId || String(formId) === String(FORM_ID)) return true;
    } catch {
      return true; // unparseable payload — sync anyway, it's cheap
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.set('trust proxy', true);

app.use(express.static(PUBLIC_DIR));

// Planning Center webhook: people.v2.events.form_submission.created
app.post('/webhooks/planning-center', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  if (!config.pcWebhookSecret) return res.sendStatus(404);
  if (!verifyPcSignature(req.body, req.get('X-PCO-Webhooks-Authenticity'))) {
    return res.sendStatus(401);
  }
  let body;
  try { body = JSON.parse(req.body.toString('utf8')); } catch { return res.sendStatus(400); }
  res.sendStatus(200); // ack fast; sync runs async
  if (cache && isOurFormSubmission(body)) scheduleWebhookSync();
});

// App routes — all serve the same SPA; client JS picks the view from the path
app.get('/', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'world.html')));
app.get('/world', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'world.html')));
app.get('/sf', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'world.html')));
app.get('/tv', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'world.html')));
app.get('/tv/sf', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'world.html')));
app.get('/status', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'status.html')));

// Community Group pages
app.get('/start-group', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'cg-start.html')));
app.get(['/join', '/join/:code'], (_req, res) => res.sendFile(join(PUBLIC_DIR, 'cg-join.html')));
app.get('/cg/:code', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'cg.html')));

// ---------------------------------------------------------------------------
// Community Group API
// ---------------------------------------------------------------------------

function requireGroups(_req, res, next) {
  if (!groups) return res.status(503).json({ error: 'Groups are not available right now. Try again in a minute.' });
  next();
}

function sendError(res, err) {
  if (err.status === 400) return res.status(400).json({ error: err.message });
  console.error('[index] Group write failed:', err.message);
  res.status(500).json({ error: 'Something went wrong saving that. Please try again.' });
}

app.post('/api/groups', express.json(), requireGroups, async (req, res) => {
  try {
    const g = await groups.create(req.body ?? {});
    res.json({ group: publicGroup(g), links: groupLinks(req, g.code) });
  } catch (err) { sendError(res, err); }
});

app.get('/api/groups/:code', requireGroups, (req, res) => {
  const g = groups.get(req.params.code);
  if (!g) return res.status(404).json({ error: "We couldn't find that group code." });
  res.json({ group: publicGroup(g), links: groupLinks(req, g.code) });
});

app.post('/api/groups/:code/join', express.json(), requireGroups, async (req, res) => {
  try {
    const { group } = await groups.join(req.params.code, [req.body?.email]);
    res.json({ group: publicGroup(group) });
    pushGroupState(group.code);
  } catch (err) { sendError(res, err); }
});

app.get('/api/groups/:code/state', requireGroups, (req, res) => {
  const g = groups.get(req.params.code);
  if (!g) return res.status(404).json({ error: "We couldn't find that group code." });
  if (!cache) return res.status(503).json({ error: 'State not yet available' });
  res.json(groupState(g));
});

// Demo mode for the CG page: the first ?joined= sample members, through the real processor
app.get('/api/groups/:code/demo', (req, res) => {
  if (!cache) return res.status(503).json({ error: 'State not yet available' });
  const g = groups?.get(req.params.code);
  const { responses, members } = demoGroup(parseInt(req.query.joined ?? DEMO_MEMBER_COUNT));
  const state = processResponses({ ...cache.sheetData(), responses }, { ...config, showTestRows: false }, geonames);
  res.json({
    type: 'state',
    ...serializeState({ ...state, isLive: true }),
    group: g ? publicGroup(g) : { code: req.params.code.toUpperCase(), groupName: 'Sunset CG' },
    members,
    demoTotal: DEMO_MEMBER_COUNT,
  });
});

// QR codes on the CG page: 1 takes the survey, 2 joins the group
const SURVEY_URL = `https://realitysf.churchcenter.com/people/forms/${FORM_ID}`;

async function sendQr(res, url) {
  const svg = await QRCode.toString(url, {
    type: 'svg', margin: 1, errorCorrectionLevel: 'M',
    color: { dark: '#081330', light: '#F4EEE0' },
  });
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=3600').send(svg);
}

app.get('/api/qr/survey.svg', (_req, res) => sendQr(res, SURVEY_URL));

app.get('/api/groups/:code/qr.svg', requireGroups, (req, res) => {
  const g = groups.get(req.params.code);
  if (!g) return res.sendStatus(404);
  sendQr(res, groupLinks(req, g.code).join);
});

// API: current state as JSON
app.get('/api/state', (_req, res) => {
  if (!currentState) {
    return res.status(503).json({ error: 'State not yet available' });
  }
  res.json(serializeState(currentState));
});

// API: SSE stream
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // ?group=CODE: a Community Group screen, sent only that group's results
  const g = req.query.group ? groups?.get(String(req.query.group)) : null;
  const clients = g
    ? (groupSseClients.get(g.code) ?? groupSseClients.set(g.code, new Set()).get(g.code))
    : sseClients;

  // Send current state immediately on connect
  if (g && cache) {
    res.write(`data: ${JSON.stringify(groupState(g))}\n\n`);
  } else if (!g && currentState) {
    res.write(`data: ${JSON.stringify({ type: 'state', ...serializeState(currentState) })}\n\n`);
  }

  clients.add(res);

  // Keep-alive ping every 15s
  const pingInterval = setInterval(() => {
    res.write(': ping\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(pingInterval);
    clients.delete(res);
  });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function start() {
  // Load city data
  const citiesPath = join(DATA_DIR, 'cities15k.json');
  try {
    await geonames.initGeonames(citiesPath);
    console.log('[index] GeoNames loaded.');
  } catch (err) {
    console.warn('[index] GeoNames load failed (city lookups disabled):', err.message);
  }

  const port = parseInt(process.env.PORT ?? '3000');
  app.listen(port, () => {
    console.log(`[index] Server listening on http://localhost:${port}`);
  });

  // Demo mode: load static demo-state.json, no Sheet polling
  if (process.env.DEMO_MODE === 'true') {
    const demoPath = join(DATA_DIR, 'demo-state.json');
    try {
      const raw = JSON.parse(await readFile(demoPath, 'utf8'));
      // Restore Maps from plain objects for serializeState compatibility
      currentState = {
        ...raw,
        countryPicks: new Map(Object.entries(raw.countryPicks)),
        regionPicks: new Map(Object.entries(raw.regionPicks)),
        regionCountries: new Map(Object.entries(raw.regionCountries)),
        heartbeatCounts: new Map(Object.entries(raw.heartbeatCounts)),
        vocationCounts: new Map(Object.entries(raw.vocationCounts)),
        readAt: new Date(raw.readAt),
        isLive: true,
      };
      console.log('[index] DEMO_MODE: loaded demo-state.json');
    } catch (err) {
      console.error('[index] DEMO_MODE: failed to load demo-state.json:', err.message);
    }
    return; // skip Sheet polling
  }

  const sheetId = process.env.SHEET_ID;
  if (!sheetId) throw new Error('SHEET_ID not set');

  // One full read at startup; everything after is incremental
  cache = createSheetCache(sheetId);
  for (let attempt = 1; ; attempt++) {
    try {
      await cache.init();
      break;
    } catch (err) {
      console.error(`[index] Initial Sheet load failed (attempt ${attempt}):`, err.message);
      await new Promise(r => setTimeout(r, Math.min(30000, 2000 * attempt)));
    }
  }
  console.log(`[index] Loaded ${cache.rowCount} response row(s).`);

  const store = createGroupStore(sheetId);
  try {
    await store.init();
    groups = store;
    console.log('[index] Community Groups loaded.');
  } catch (err) {
    console.error('[index] Community Groups load failed (group pages disabled):', err.message);
  }
  rebuildState();

  // Catch up on anything submitted while we were down, then rely on the webhook
  await runPcSync('startup');

  setInterval(checkSheet, config.sheetReadIntervalMs);
  setInterval(checkReference, config.referenceRefreshMs);
  if (config.pcPollIntervalMs > 0) {
    setInterval(() => runPcSync('poll'), config.pcPollIntervalMs);
  }
  console.log(
    `[index] Meta check every ${config.sheetReadIntervalMs / 1000}s; ` +
    `PC ${config.pcWebhookSecret ? 'webhook enabled' : 'webhook not configured'}` +
    (config.pcPollIntervalMs > 0 ? `, polling every ${config.pcPollIntervalMs / 1000}s` : ', no polling') + '.',
  );
}

start().catch(err => {
  console.error('[index] Fatal startup error:', err);
  process.exit(1);
});
