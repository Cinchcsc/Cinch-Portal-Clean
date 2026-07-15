// Read-only: dumps the most recent refresh_log rows (NO SiteLink calls, instant) — this is the
// table every cron/pull writes a 'running' row into on start and updates to 'ok'/'error'/'partial'
// on finish (see lib/pullLock.js). ADDED 15 Jul 2026 (Michael: "is there a different way you can
// confirm the auto updates" — I don't have Supabase/Vercel credentials in my own sandbox, so this
// is the quickest way to check whether the 7 daily crons (5x /api/pull report-groups, pull-snapshot,
// pull-cockpit) actually fired and succeeded, without waiting on the portal UI to reflect it).
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
console.log(`\n${todays.length} row(s) started today (${today}, UTC-ish) — expect 7 once the first full overnight cycle has run (5x pull, 1x snapshot, 1x cockpit).`);
process.exit(0);
