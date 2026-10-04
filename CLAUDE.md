# CLAUDE.md — neighbors-and-nations

## Purpose

Live dashboard for a church survey ("Neighbors & Nations"). Shows where congregants have connections around the world — countries, SF/Bay Area neighborhoods, and broad regions — updated in near-real-time from a Google Spreadsheet.

## Architecture

| File | Role |
|---|---|
| `src/config.js` | Single frozen config object. All tunable knobs live here. |
| `src/sheets.js` | Read-only Google Sheets reader. Exports `readSheet(sheetId, credentials?)`. |
| `src/processor.js` | Pure data transformation. `processResponses(sheetData, config, geonames)` → ProcessedState. No I/O. |
| `src/geonames.js` | In-memory city lookup from `data/cities15k.json`. Also exports `countryNameToCode`. |
| `src/index.js` | Express server, SSE stream, polling loop. |

## Google Sheet Tab Structure

| Tab | Purpose |
|---|---|
| **Responses** | One row per survey submission. Headers in row 1. |
| **Lists** | Column-per-list layout. Row 1 = list names (vocations, heartbeats, etc). Rows 2+ = values. |
| **Regions** | Col A = country name, Col B = region name. |
| **Cities** | Manual lat/lng overrides. Cols: typed_text, country, lat, lng. |
| **Approvals** | Write-in text moderation. Cols: write_in_text, approved (TRUE/FALSE), show_as. |

### Responses Tab Columns

`person_id`, `submitted_at`, `is_test`, `vocation_1..3`, `heartbeat_1..3`, `connect_1..3_place`, `connect_1..3_city`, `connect_where_i_live`, `lives_area`, `lives_place`

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Yes | — | Full JSON string of service account credentials |
| `SHEET_ID` | Yes | — | Google Spreadsheet ID |
| `PORT` | No | 3000 | HTTP port |
| `SHEET_READ_INTERVAL_MS` | No | 5000 | Poll interval in ms |
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
npm run stream    # append 1 row every 3s (--interval <ms> to override)
```

## Key Design Decisions

- **processor.js is pure** — takes SheetData as input, returns ProcessedState. No network, no file I/O.
- **Maps are serialized to plain objects** for JSON (SSE and `/api/state`).
- **Sheets is the source of truth** — in-memory state is rebuilt on each poll from raw Sheet data.
- **City lookup priority**: `cityFixes` map (manual overrides in Cities tab) → `geonames.lookupCity()` (bundled JSON).
- **Deduplication**: latest `submitted_at` per `person_id` wins.
