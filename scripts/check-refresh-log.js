// Read-only: dumps the most recent refresh_log rows (NO SiteLink calls, instant) — this is the
// table every cron/pull writes a 'running' row into on start and updates to 'ok'/'error'/'partial'
// on finish (see lib/pullLock.js). ADDED 15 Jul 2026 (Michael: "is there a different way you can
// confirm the auto updates" — I don't have Supabase/Vercel credentials in my own sandbox, so this
// is the quickest way to check whether the daily crons actually fired and succeeded, without waiting
// on the portal UI to reflect it).
//
// Note: all 5 of the /api/pull?reports=... cron slots share kind='pull' (they call the same
// runPull() with different `reports` overrides) — there's no per-slot label stored, so distinguish
// them by started_at falling in separate hours (1,2,3,4,5 UTC), not by kind. 'snapshot' (hour 6) and
// 'cockpit' (hour 7) are their own kinds.
//   npm run check:refresh-log
import { admin } from '../lib/supabaseAdmin.js';

const { data, error } = await admin
  .from('refresh_log').select('id,kind,status,started_at,finished_at,detail')
  .order('started_at', { ascending: false }).limit(20);

if (error) { console.log('refresh_log read error:', error.message); process.exit(1); }
if (!data?.length) { console.log('refresh_log: no rows yet.'); process.exit(0); }

console.log('id     kind       status     started_at                finished_at               duration');
console.log('----------------------------------------------------------------------------------------------');
for (const r of data) {
  const dur = r.finished_at ? Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 1000) + 's' : '(running)';
  console.log(
    `${String(r.id).padEnd(6)} ${(r.kind || '?').padEnd(10)} ${(r.status || '?').padEnd(10)} ${r.started_at.padEnd(25)} ${(r.finished_at || '').padEnd(25)} ${dur}`
  );
  if (r.detail) console.log(`       detail: ${r.detail.slice(0, 400)}`);
}

const today = new Date().toISOString().slice(0, 10);
const todays = data.filter((r) => r.started_at.startsWith(today));
// UPDATED 21 Jul 2026 (cron-timeout investigation): was "expect 8" — stale again within the SAME day
// it was written. Went 7 -> 8 on 20 Jul when /api/rebuild-payload's own 'rebuild'-kind cron (task
// #297/#328, added 17 Jul) started writing its own row. Then, 16 minutes after that fix was commented
// in here (see commit 22360aa, 11:31+01:00), commit 97eb685 (11:53+01:00, task #327 "fixed properly")
// site-sharded true_revenue 4 ways across ITS OWN 3 new hourly cron slots (10/11/12), on top of the
// one it already had (hour 5) — turning 5x pull into 9x pull. 13 daily crons total now: 9x pull
// (hours 1,2,3,4,5,9,10,11,12 — all kind='pull', distinguished only by started_at hour — see comment
// above), 1x snapshot (hour 6), 1x cockpit (hour 7), 1x rebuild (hour 8), 1x floor (hour 13, added
// 21 Jul 2026 to auto-refresh the Occupancy by Floor widget's unit_floor_status snapshot). Check
// vercel.json directly if this drifts again rather than trusting this count.
console.log(`\n${todays.length} row(s) started today (${today}, UTC-ish) — expect 13 once the first full overnight cycle has run (9x pull, 1x snapshot, 1x cockpit, 1x rebuild, 1x floor).`);
process.exit(0);
