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
import { createGroupStore, publicGroup, memberList, maskEmail } from './groups.js';
import { demoGroup, DEMO_MEMBER_COUNT } from './demo.js';
import { createPartnerStore, publicPartner, matchPartners } from './partners.js';

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
/** @type {ReturnType<typeof createPartnerStore> | null} */
let partners = null;

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
    regionReach: Object.fromEntries(state.regionReach ?? []),
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
  // Who has joined, newest first; emails are masked here so full addresses never leave the server
  const roster = memberList(g).map(m => ({ email: maskEmail(m.email) }));
  return {
    type: 'state',
    ...serializeState({ ...state, isLive: sheetsHealthy }),
    group: info,
    members: roster,
  };
}

/**
 * Tiny in-memory rate limiter, per client IP. A CG night has a whole group on
 * one church wifi, so the join limit is generous; looking up codes that don't
 * exist is limited hard, so codes (and the emails behind them) can't be guessed.
 */
function rateLimit({ windowMs, max, message, countEveryRequest = true }) {
  const hits = new Map(); // ip → [timestamps]
  return {
    middleware(req, res, next) {
      const now = Date.now();
      const recent = (hits.get(req.ip) ?? []).filter(t => now - t < windowMs);
      hits.set(req.ip, recent);
      if (recent.length >= max) return res.status(429).json({ error: message });
      if (countEveryRequest) recent.push(now);
      next();
    },
    /** Count one request by hand, for limits that don't count every request */
    hit(req) {
      const recent = hits.get(req.ip) ?? [];
      recent.push(Date.now());
      hits.set(req.ip, recent);
    },
    sweep() {
      const now = Date.now();
      for (const [ip, ts] of hits) if (!ts.some(t => now - t < windowMs)) hits.delete(ip);
    },
  };
}

const TEN_MIN = 10 * 60 * 1000;
const createLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: 'Too many groups created from here. Try again later.' });
const joinLimit = rateLimit({ windowMs: TEN_MIN, max: 150, message: 'Too many joins from here. Try again in a few minutes.' });
const missLimit = rateLimit({ windowMs: TEN_MIN, max: 30, message: 'Too many tries. Try again in a few minutes.', countEveryRequest: false });
setInterval(() => [createLimit, joinLimit, missLimit].forEach(l => l.sweep()), TEN_MIN).unref();

/** Look up a group by the :code param; unknown codes count against the miss limit. */
function findGroup(req) {
  const g = groups.get(req.params.code);
  if (!g) missLimit.hit(req);
  return g;
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
  // J&O edit the Partners tab by hand; pick up their changes on the same schedule
  partners?.load().catch(err => console.error('[index] Partners tab read failed (keeping cached list):', err.message));
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
// One proxy hop (Railway's edge): req.ip is the visitor, not a spoofable header
app.set('trust proxy', 1);

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
app.get('/cg', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'cg-index.html')));
app.get('/cg/:code', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'cg.html')));
app.get(['/partners', '/cg/:code/partners'], (_req, res) => res.sendFile(join(PUBLIC_DIR, 'partners.html')));

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

// Every CG that's been set up, for the /cg page
app.get('/api/groups', requireGroups, (_req, res) => {
  res.json({ groups: groups.list().map(g => ({ ...publicGroup(g), memberCount: memberList(g).length })) });
});

// For the start form: is this CG name free, and what code would it get?
app.get('/api/groups/check', requireGroups, (req, res) => {
  res.json(groups.preview(String(req.query.name ?? '').slice(0, 200)));
});

app.post('/api/groups', createLimit.middleware, express.json({ limit: '10kb' }), requireGroups, async (req, res) => {
  try {
    const g = await groups.create(req.body ?? {});
    res.json({ group: publicGroup(g), links: groupLinks(req, g.code) });
  } catch (err) { sendError(res, err); }
});

app.get('/api/groups/:code', missLimit.middleware, requireGroups, (req, res) => {
  const g = findGroup(req);
  if (!g) return res.status(404).json({ error: "We couldn't find that group code." });
  res.json({ group: publicGroup(g), links: groupLinks(req, g.code) });
});

app.post('/api/groups/:code/join', joinLimit.middleware, missLimit.middleware, express.json({ limit: '10kb' }), requireGroups, async (req, res) => {
  try {
    if (!findGroup(req)) return res.status(400).json({ error: "We couldn't find that group code. Check it and try again." });
    const { group } = await groups.join(req.params.code, [req.body?.email]);
    res.json({ group: publicGroup(group) });
    pushGroupState(group.code);
  } catch (err) { sendError(res, err); }
});

app.get('/api/groups/:code/state', missLimit.middleware, requireGroups, (req, res) => {
  const g = findGroup(req);
  if (!g) return res.status(404).json({ error: "We couldn't find that group code." });
  if (!cache) return res.status(503).json({ error: 'State not yet available' });
  res.json(groupState(g));
});

/** Demo-mode state: the first `joined` sample members, through the real processor */
function demoState(code, joined) {
  const g = groups?.get(code);
  const { responses, members } = demoGroup(joined);
  const state = processResponses({ ...cache.sheetData(), responses }, { ...config, showTestRows: false }, geonames);
  return {
    type: 'state',
    ...serializeState({ ...state, isLive: true }),
    group: g ? publicGroup(g) : { code: String(code).toUpperCase(), groupName: 'Sunset CG' },
    groupExists: !!g,
    members,
    demoTotal: DEMO_MEMBER_COUNT,
  };
}

// Demo mode for the CG page: the first ?joined= sample members
app.get('/api/groups/:code/demo', (req, res) => {
  if (!cache) return res.status(503).json({ error: 'State not yet available' });
  res.json(demoState(req.params.code, parseInt(req.query.joined) || 0));
});

// ---------------------------------------------------------------------------
// Partners and missionaries
// ---------------------------------------------------------------------------

function requirePartners(_req, res, next) {
  if (!partners) return res.status(503).json({ error: 'Partners are not available right now. Try again in a minute.' });
  next();
}

// Everyone, for the church-wide page
app.get('/api/partners', requirePartners, (_req, res) => {
  res.json({ partners: partners.visible().map(publicPartner) });
});

// Everyone, with the ones that fit this group highlighted and the reasons why.
// ?demo matches against the demo group's sample answers instead.
app.get('/api/groups/:code/partners', missLimit.middleware, requirePartners, (req, res) => {
  if (!cache) return res.status(503).json({ error: 'State not yet available' });
  let state;
  if (req.query.demo !== undefined) {
    state = demoState(req.params.code, DEMO_MEMBER_COUNT);
  } else {
    if (!groups) return res.status(503).json({ error: 'Groups are not available right now. Try again in a minute.' });
    const g = findGroup(req);
    if (!g) return res.status(404).json({ error: "We couldn't find that group code." });
    state = groupState(g);
  }
  res.json({
    group: state.group,
    totalPeople: state.totalPeople,
    partners: matchPartners(partners.visible(), state).map(({ partner, fit, reasons }) => ({ ...publicPartner(partner), fit, reasons })),
  });
});

// QR codes on the CG page: 1 takes the survey, 2 joins the group
const SURVEY_URL = `https://realitysf.churchcenter.com/people/forms/${FORM_ID}`;

async function sendQr(res, url, cache) {
  const svg = await QRCode.toString(url, {
    type: 'svg', margin: 1, errorCorrectionLevel: 'M',
    color: { dark: '#081330', light: '#F4EEE0' },
  });
  res.type('image/svg+xml').set('Cache-Control', cache).send(svg);
}

app.get('/api/qr/survey.svg', (_req, res) => sendQr(res, SURVEY_URL, 'public, max-age=3600'));

// Built from the request's host, so never cached by anything shared
app.get('/api/groups/:code/qr.svg', missLimit.middleware, requireGroups, (req, res) => {
  const g = findGroup(req);
  if (!g) return res.sendStatus(404);
  sendQr(res, groupLinks(req, g.code).join, 'private, max-age=3600');
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
    if (g && clients.size === 0) groupSseClients.delete(g.code);
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

  const partnerStore = createPartnerStore(sheetId);
  try {
    await partnerStore.load();
    partners = partnerStore;
    console.log(`[index] Partners loaded (${partners.visible().length} shown).`);
  } catch (err) {
    console.error('[index] Partners load failed (partner pages disabled):', err.message);
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
