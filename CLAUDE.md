# CLAUDE.md — neighbors-and-nations

## Purpose

Live dashboard for a church survey ("Neighbors & Nations"). Shows where congregants have connections around the world — countries, SF/Bay Area neighborhoods, and broad regions — updated in near-real-time from a Google Spreadsheet.

## Architecture

| File | Role |
|---|---|
| `src/config.js` | Single frozen config object. All tunable knobs live here. |
| `src/sheets.js` | Google Sheets I/O: `readSheet` (full read, scripts), plus incremental helpers — `readMeta`/`writeMeta`, `readResponsesFull`, `readResponseRows`, `readReferenceTabs`, append-only `appendRows`. |
| `src/sheet-cache.js` | Server-side cache of the Sheet. One full read at startup, then `checkForUpdates()` reads Meta and fetches only rows past the cached count. Holds the submission-ID dedup set. |
| `src/sync-pc.js` | Planning Center → Sheets. Lists submissions since Meta `last_synced_at` (−1h lookback), skips known ones *before* fetching details, appends new rows, updates Meta. |
| `src/processor.js` | Pure data transformation. `processResponses(sheetData, config, geonames)` → ProcessedState. No I/O. |
| `src/geonames.js` | In-memory city lookup from `data/cities15k.json`. Also exports `countryNameToCode` / `countryAliases`, derived from `countries.json`. |
| `public/data/countries.json` | Single country list shared by server and map: name, alpha-2, ISO numeric (zero-padded), typed-name `aliases`, and extra map `shapes` (territories rolled into a parent, e.g. Puerto Rico → US). |
| `src/index.js` | Express server, SSE stream, Meta check loop, Planning Center webhook (`POST /webhooks/planning-center`). |

## Google Sheet Tab Structure

| Tab | Purpose |
|---|---|
| **Responses** | One row per survey submission. Headers in row 1. |
| **Lists** | Column-per-list layout. Row 1 = list names (vocations, heartbeats, etc). Rows 2+ = values. |
| **Regions** | Col A = country name, Col B = region name. |
| **Cities** | Manual lat/lng overrides. Cols: typed_text, country, lat, lng. |
| **Approvals** | Write-in text moderation. Cols: write_in_text, approved (TRUE/FALSE), show_as. |
| **Meta** | Change marker, written by the app. Key/value rows: `last_synced_at`, `last_submission_id`, `row_count`, `last_updated`. Created automatically; reconciled with Responses on every startup. |

### Responses Tab Columns

`person_id`, `submitted_at`, `is_test`, `vocation_1..3`, `heartbeat_1..3`, `connect_1..3_place`, `connect_1..3_city`, `connect_where_i_live`, `lives_area`, `lives_place`, `submission_id`, `email_key`, `vocation_extra`, `heartbeat_extra`

The form asks for up to 3 vocations/heartbeats but Planning Center can't enforce it, so nothing is dropped: picks 4+ go into `*_extra`, joined with ` | `, and are counted like the others.

`submission_id` (Planning Center form submission ID) and `email_key` (first 16 hex chars of SHA-256 of the person's lowercased primary email — the address itself is never stored) were added later; their header cells are written on startup if missing. Older rows have neither: sync dedups them by `person_id|submitted_at`, and the processor links them to an `email_key` via `person_id`.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Yes | — | Full JSON string of service account credentials |
| `SHEET_ID` | Yes | — | Google Spreadsheet ID |
| `PORT` | No | 3000 | HTTP port |
| `SHEET_READ_INTERVAL_MS` | No | 30000 | How often the Meta tab is checked for new rows |
| `REFERENCE_REFRESH_MS` | No | 300000 | How often Lists/Regions/Approvals are re-read |
| `PLANNING_CENTER_WEBHOOK_SECRET` | No | — | Webhook authenticity secret. When set, PC polling is off |
| `PC_POLL_INTERVAL_MS` | No | 0 with webhook, else 30000 | Fallback PC poll |
| `SHOW_TEST_ROWS` | No | false | Include `is_test=TRUE` rows |

## Running Locally

```bash
cp .env.example .env
# fill in GOOGLE_SERVICE_ACCOUNT_JSON and SHEET_ID
npm install
npm run dev       # starts with --watch
npm test          # processor unit tests (no Sheet API needed)
npm run seed      # seed ~300 dummy rows into Sheet
npm run seed -- --dry-run   # print CSV to stdout instead
npm run stream    # append 1 row every 3s (--interval <ms> to override); bumps Meta
npm run sync-pc -- --dry-run   # show what a PC sync would append (writes nothing)
npm run pc-webhook -- https://<host>/webhooks/planning-center   # subscribe; prints the secret
```

## Key Design Decisions

- **processor.js is pure** — takes SheetData as input, returns ProcessedState. No network, no file I/O.
- **Maps are serialized to plain objects** for JSON (SSE and `/api/state`).
- **Sheets is the source of truth** — loaded fully once at startup; afterwards only Meta is polled and only new rows are fetched. State is re-processed (in memory) and pushed over SSE only when something changed.
- **Responses is append-only** — the app never clears or rewrites existing rows (only `npm run seed`, a dev tool, does).
- **Anything that appends to Responses must update Meta `row_count`**, or the server won't see the rows until restart.
- **City lookup priority**: `cityFixes` map (manual overrides in Cities tab) → `geonames.lookupCity()` (bundled JSON).
- **Deduplication**: sync skips any PC submission ID already in the Sheet. The processor then keeps the latest `submitted_at` per person, where a person is their `email_key` (so duplicate PC profiles with the same email collapse), falling back to `person_id`. A resubmission replaces that person's earlier answers.
