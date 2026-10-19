/**
 * sync-from-pc.js
 *
 * Manual CLI wrapper around src/sync-pc.js (same dedup, append-only writes
 * and Meta update as the server).
 *
 * Usage:
 *   node scripts/sync-from-pc.js              # sync new submissions only
 *   node scripts/sync-from-pc.js --dry-run    # print rows without writing
 *   node scripts/sync-from-pc.js --full       # list all submissions (ignores last_synced_at; still deduped)
 */

import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initGeonames } from '../src/geonames.js';
import { createSheetCache } from '../src/sheet-cache.js';
import { syncPlanningCenter } from '../src/sync-pc.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FULL_SYNC = args.includes('--full');

async function main() {
  const sheetId = process.env.SHEET_ID;
  if (!sheetId) throw new Error('SHEET_ID not set');

  try {
    await initGeonames(join(__dirname, '..', 'data', 'cities15k.json'));
  } catch {
    console.warn('[sync] GeoNames unavailable — City-type connections will not have a country resolved.');
  }

  console.log('[sync] Loading Sheet…');
  const cache = createSheetCache(sheetId);
  await cache.init({ readOnly: DRY_RUN });
  console.log(`[sync] ${cache.rowCount} existing row(s); last synced ${cache.meta?.last_synced_at || 'never'}.`);

  const result = await syncPlanningCenter(sheetId, cache, { full: FULL_SYNC, dryRun: DRY_RUN });

  if (result.newCount === 0) {
    console.log('[sync] Nothing to do.');
    return;
  }

  if (DRY_RUN) {
    console.log('\n[sync] DRY RUN — rows that would be appended:\n');
    for (const row of result.rows) {
      console.log(JSON.stringify(Object.fromEntries(cache.header.map((col, i) => [col, row[i]])), null, 2));
    }
    if (result.unmatchedItems.length > 0) {
      console.log('\n[sync] Unmatched items that would be logged:\n');
      for (const item of result.unmatchedItems) console.log(' ', JSON.stringify(item));
    }
    return;
  }

  console.log(`[sync] Wrote ${result.newCount} row(s) to Sheets (${result.unmatchedCount} unmatched).`);
}

main().catch(err => {
  console.error('[sync] Fatal:', err.message);
  process.exit(1);
});
