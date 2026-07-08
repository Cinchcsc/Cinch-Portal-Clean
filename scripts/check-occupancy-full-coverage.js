// FIXED 8 Jul 2026: the original version of this script queried raw_report with NO pagination
// (`.select('month').eq('report','occupancy')`, no `.range()`), which Supabase silently caps at a
// default row limit — it only ever returned the oldest ~1000-ish rows by id, which happened to be
// leftover 2016-2019 test/sample data from early development. That made it look like occupancy's
// real 2020-2026 data had vanished entirely, when it was actually sitting there fine at higher row
// ids the whole time — this script just never paged far enough to see it. Sent a chunk of this
// session's investigation down the wrong path (crashing-cron / "first portal" data-loss theory)
// before backfill.js's own properly-paginated existing-rows check (see scripts/backfill.js) revealed
// the real 2020-2026 data was present all along and only June 2026 had a genuine gap. Now paginates
// properly, same pattern as fetchAllRaw()/backfill.js, so this gives a trustworthy answer.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-occupancy-full-coverage.js
import { admin } from '../lib/supabaseAdmin.js';

const PAGE = 1000;
let occRows = [];
for (let from = 0; ; from += PAGE) {
  const { data, error } = await admin.from('raw_report').select('month').eq('report', 'occupancy').order('id').range(from, from + PAGE - 1);
  if (error) { console.error(error.message); process.exit(1); }
  occRows = occRows.concat(data);
  if (!data || data.length < PAGE) break;
}
const months = [...new Set(occRows.map((r) => String(r.month).slice(0, 7)))].sort();
console.log(`occupancy currently has rows in ${months.length} distinct month(s).`);
console.log(`Earliest: ${months[0]}   Latest: ${months[months.length - 1]}`);

// Look for gaps in the otherwise-contiguous monthly sequence.
const gaps = [];
for (let i = 1; i < months.length; i++) {
  const [py, pm] = months[i - 1].split('-').map(Number);
  const [cy, cm] = months[i].split('-').map(Number);
  const expectedNext = pm === 12 ? `${py + 1}-01` : `${py}-${String(pm + 1).padStart(2, '0')}`;
  if (months[i] !== expectedNext) gaps.push(`${months[i - 1]} -> ${months[i]} (missing ${expectedNext}${expectedNext !== months[i] ? '...' : ''})`);
}
console.log(`\nGaps in the month sequence: ${gaps.length ? '' : '(none — fully contiguous)'}`);
for (const g of gaps) console.log('  ' + g);
console.log(`\nIs 2026-06 present right now? ${months.includes('2026-06') ? 'YES' : 'NO — confirms check-june-month-keys.js'}`);

// refresh_log: recent runPull() activity, in case a scheduled pull ran during the ~3.5hr management
// repull window and is worth cross-referencing by time (runPull() itself has no delete step, but
// ruling it in/out by timestamp is cheap and worth doing before looking elsewhere).
const { data: logs, error: logErr } = await admin.from('refresh_log').select('id,started_at,finished_at,status,detail').order('started_at', { ascending: false }).limit(10);
if (logErr) { console.log(`\n(refresh_log query failed: ${logErr.message})`); }
else {
  console.log(`\nLast ${logs.length} refresh_log entries (most recent first):`);
  for (const l of logs) {
    console.log(`  #${l.id}  started=${l.started_at}  finished=${l.finished_at ?? '(still running / crashed?)'}  status=${l.status}`);
    if (l.detail) console.log(`      detail: ${l.detail.slice(0, 200)}`);
  }
}
process.exit(0);
