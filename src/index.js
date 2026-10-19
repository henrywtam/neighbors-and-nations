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

/** @type {ReturnType<typeof createSheetCache> | null} */
let cache = null;

/** Whether the last Sheets check succeeded (drives the Live/Reconnecting badge). */
let sheetsHealthy = true;

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
  };
}

function pushSseEvent(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

// ---------------------------------------------------------------------------
// Sheet → map
// ---------------------------------------------------------------------------

function rebuildState() {
  const newState = processResponses(cache.sheetData(), config, geonames);
  currentState = { ...newState, isLive: sheetsHealthy };
  pushSseEvent({ type: 'state', ...serializeState(currentState) });
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
    markHealthy(true);
    if (changed) {
      console.log(`[index] Sheet has new rows (now ${cache.rowCount}).`);
      rebuildState();
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
app.get('/status', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'status.html')));

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

  // Send current state immediately on connect
  if (currentState) {
    res.write(`data: ${JSON.stringify({ type: 'state', ...serializeState(currentState) })}\n\n`);
  }

  sseClients.add(res);

  // Keep-alive ping every 15s
  const pingInterval = setInterval(() => {
    res.write(': ping\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(pingInterval);
    sseClients.delete(res);
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
