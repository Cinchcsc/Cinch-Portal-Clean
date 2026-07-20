// PROBE (20 Jul 2026), harmless — isolates WRITE cost from READ/COMPUTE cost for the portal_payload
// rebuild, following 3 CONSECUTIVE "canceling statement due to statement timeout" failures (see
// lib/rebuildPayload.js's withRetry() comment). probe-rawreport-growth.js already showed raw_report's
// total data volume is modest (~15.6MB across 45.7k rows) — too small to obviously explain a 27-30s+
// timeout from read cost alone, and status.supabase.com shows no current platform incident (the one
// referenced in this codebase's older comments was resolved 13 Jul). That leaves the FINAL single
// portal_payload upsert (writing the whole computed payload — sites/totals/history/monthly for the
// full 2016-2026 history — as one JSONB blob) as the next most likely bottleneck.
//
// This fetches the CURRENTLY STORED (live) portal_payload row — still the last successful rebuild's
// payload, since a failed upsert rolls back and never overwrites it — and re-writes that EXACT SAME
// payload to a SCRATCH row (id=999, never read by the live portal/API) with fresh timing around just
// the write. Does NOT touch the live id=1 row's content. Deletes the scratch row afterward either way.
//
// Run: cd cinch-portal-clean && node --env-file=.env scripts/probe-payload-write-time.js
import { admin } from '../lib/supabaseAdmin.js';

const { data: existing, error: fetchErr } = await admin.from('portal_payload').select('payload,generated_at').eq('id', 1).single();
if (fetchErr) { console.error('Fetch of live portal_payload failed:', fetchErr.message); process.exit(1); }

const bytes = JSON.stringify(existing.payload).length;
console.log(`Currently stored (live) portal_payload size: ${(bytes / 1e6).toFixed(2)} MB (last generated_at: ${existing.generated_at})`);

console.log('\nTiming an isolated write of this SAME payload to a scratch row (id=999, never read by the');
console.log('live portal) — isolates write cost from buildPayload()\'s own read+compute...');
const started = Date.now();
const { error: upsertErr } = await admin.from('portal_payload').upsert({ id: 999, generated_at: new Date().toISOString(), payload: existing.payload });
const durationMs = Date.now() - started;

// Clean up the scratch row either way so nothing lingers in the table.
const { error: delErr } = await admin.from('portal_payload').delete().eq('id', 999);
if (delErr) console.error(`(cleanup) failed to delete scratch row 999: ${delErr.message} — harmless but delete it manually if you notice it later.`);

if (upsertErr) {
  console.error(`\nScratch write FAILED after ${durationMs}ms — ${upsertErr.message}`);
  console.error('This isolates the bottleneck to the WRITE side (one large JSONB upsert), not buildPayload()\'s read/compute — the fix is reducing/splitting what gets written, not retrying harder.');
  process.exit(1);
}
console.log(`\nScratch write succeeded in ${durationMs}ms.`);
console.log(durationMs > 15000
  ? 'Slow even in isolation — the write itself is a meaningful share of (or the whole) timeout risk.'
  : 'Fast — the bottleneck is more likely in buildIndex()/buildPayload()\'s own read+compute path (fetchAllRaw/fetchAutobillDailyMap/recordFor loops), not this write.');
process.exit(0);
