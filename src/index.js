import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import { readSheet } from './sheets.js';
import { processResponses } from './processor.js';
import * as geonames from './geonames.js';
import config from './config.js';
import { syncPlanningCenter } from './sync-pc.js';

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
// Sheet polling
// ---------------------------------------------------------------------------

async function refreshState() {
  try {
    const sheetId = process.env.SHEET_ID;
    if (!sheetId) throw new Error('SHEET_ID not set');

    // 1. Pull Planning Center → Sheets (no-op if no new submissions)
    try {
      const { newCount } = await syncPlanningCenter(sheetId);
      if (newCount > 0) console.log(`[index] PC sync: ${newCount} new submission(s) written to Sheets.`);
    } catch (pcErr) {
      console.error('[index] PC sync error (continuing to Sheets read):', pcErr.message);
    }

    // 2. Read Sheets → update in-memory state
    const sheetData = await readSheet(sheetId);
    const newState = processResponses(sheetData, config, geonames);

    const changed =
      !currentState ||
      newState.totalPeople !== currentState.totalPeople ||
      newState.readAt?.toISOString() !== currentState.readAt?.toISOString();

    currentState = { ...newState, isLive: true };

    if (changed) {
      pushSseEvent({ type: 'state', ...serializeState(currentState) });
    }
  } catch (err) {
    console.error('[index] Sheet read error:', err.message);
    if (currentState) {
      currentState = { ...currentState, isLive: false };
    }
    pushSseEvent({ type: 'error', message: 'reconnecting' });
  }
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

app.use(express.static(PUBLIC_DIR));

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

  // Initial read immediately
  await refreshState();

  // Poll on interval
  setInterval(refreshState, config.sheetReadIntervalMs);
}

start().catch(err => {
  console.error('[index] Fatal startup error:', err);
  process.exit(1);
});
