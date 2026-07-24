// One-time HISTORY BACKFILL: pulls every report for every site for each of the last N complete
// months into Supabase (raw_report), then rebuilds the payload. SEQUENTIAL (SiteLink rejects
// parallel logons), so it takes a while — run overnight / over a weekend on the Mac.
//   npm run backfill            → default 36 months, all reports
//   npm run backfill 60         → last 60 months (5 yrs); older-than-available months come back empty
//   FORCE=1 npm run backfill 36 → re-pull even months already stored (default: SKIP existing = resumable)
//   BACKFILL_REPORTS=occupancy,financial,management,insurance_roll,lead_funnel,past_due npm run backfill 60
// Rough cost: ~27 sites x 13 reports = ~350 calls/month ≈ ~9 min/month ≈ ~2 hrs per year of history.
// It's RESUMABLE: re-running skips months/reports already pulled, so you can go deeper later cheaply.
import { admin } from '../lib/supabaseAdmin.js';
import { pullReport, REPORTS } from '../lib/reportMap.js';
import { buildPayload } from '../lib/buildPayload.js';

const MONTHS = Number(process.argv[2] || process.env.BACKFILL_MONTHS || 36);
const reportKeys = (process.env.BACKFILL_REPORTS || Object.keys(REPORTS).join(','))
  .split(',').map(s => s.trim()).filter(k => REPORTS[k]);
const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
if (!locations.length) { console.error('SITELINK_LOCATIONS not set'); process.exit(1); }

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now = new Date();
const targets = [];
for (let k = 1; k <= MONTHS; k++) targets.push(new Date(now.getFullYear(), now.getMonth() - k, 1));
targets.reverse();   // oldest → newest
// FIXED 23 Jul 2026 (production-readiness audit): this script targets COMPLETE historical months
// only (`k = 1..MONTHS`, so last month and older) — it never includes the real current in-progress
// month. The old `slice(-1)` bypass therefore did NOT "refresh only the current month" as the comment
// claimed; it force-refreshed the MOST RECENT CLOSED month on every rerun, defeating the resume/skip
// safety and reopening exactly the kind of locked-history overwrite this comment was trying to avoid.
// Historical backfill runs should skip any already-stored closed month unless FORCE=1 explicitly says
// otherwise, so the bypass set is intentionally empty here.
const recent = new Set();

await admin.from('sites').upsert(locations.map(code => ({ code, name: code })), { onConflict: 'code', ignoreDuplicates: true });

// preload already-stored keys so a re-run resumes instead of re-pulling (unless FORCE=1)
// FIXED 6 Jul 2026: added .order('id') — same fix as lib/buildPayload.js's fetchAllRaw(). Without a
// stable sort, .range() pagination over a large/growing table isn't guaranteed to return the same
// rows on every page across calls, which could make this resumability check silently miss already-
// stored rows (causing needless re-pulls) or skip rows entirely.
const existing = new Set();
if (process.env.FORCE !== '1') {
  for (let from = 0; ; from += 1000) {
    const { data } = await admin.from('raw_report').select('site_code,month,report').order('id').range(from, from + 999);
    if (!data || !data.length) break;
    for (const r of data) existing.add(`${r.site_code}|${r.month.slice(0, 7)}|${r.report}`);
    if (data.length < 1000) break;
  }
}

const totalCalls = locations.length * reportKeys.length * targets.length;
console.log(`Backfill: ${locations.length} sites x ${reportKeys.length} reports x ${targets.length} months = ${totalCalls} calls max (sequential).`);
console.log(existing.size ? `Resuming — ${existing.size} report-months already stored will be skipped.` : 'Fresh run.');
console.log('Reports:', reportKeys.join(', '), '\n');

const ordered = reportKeys.includes('occupancy') ? ['occupancy', ...reportKeys.filter(k => k !== 'occupancy')] : reportKeys.slice();
let ok = 0, fail = 0, skip = 0; const t0 = Date.now();
for (const month of targets) {
  // FIXED 23 Jul 2026 (production-readiness audit): closed historical months must end at the START
  // of the following day, not midnight on their final calendar day, because SiteLink treats the end
  // bound as exclusive. The old `new Date(y, m + 1, 0)` silently dropped each target month's last
  // day from every dated report in this backfill path.
  const mk = ymd(month).slice(0, 7), end = new Date(month.getFullYear(), month.getMonth() + 1, 1);
  const parseEndDate = new Date(end.getTime() - 1);
  for (const loc of locations) {
    let occEmpty = false;
    for (const key of ordered) {
      if (existing.has(`${loc}|${mk}|${key}`) && !recent.has(mk)) { skip++; continue; }
      if (occEmpty && key !== 'occupancy') { skip++; continue; }   // site wasn't open this month — skip the rest
      try {
        let data, raw;
        for (let attempt = 1; ; attempt++) {
          try { ({ data, raw } = await pullReport(key, loc, month, end, { parseEndDate })); break; }
          catch (e) { if (attempt >= 3) throw e; await sleep(2000 * attempt); }
        }
        if (key === 'occupancy' && !(data && data.total_units > 0)) occEmpty = true;
        // FIXED 23 Jul 2026 (production-readiness audit): historical backfill used to persist only
        // the parsed `data`, dropping raw_response even though the normal pull/repull paths have
        // stored it since 7 Jul 2026. That made future parser fixes unreplayable for ANY month first
        // populated by this script alone — scripts/reparse-report.js would have nothing to work with.
        // Keep backfilled rows structurally identical to live-pulled rows so every later maintenance
        // tool can treat them the same way.
        const { error } = await admin.from('raw_report').upsert(
          { site_code: loc, month: ymd(month), report: key, data, raw_response: raw ?? null, pulled_at: new Date().toISOString() },
          { onConflict: 'site_code,month,report' });
        if (error) throw new Error('DB ' + error.message);
        ok++;
      } catch (e) { fail++; if (fail <= 25) console.error(`  x ${mk}/${loc}/${key}: ${e.message}`); }
    }
  }
  console.error(`[backfill] ${mk} done — ${ok} ok / ${skip} skipped / ${fail} failed (${((Date.now() - t0) / 60000).toFixed(1)} min)`);
}

console.log(`\nPull phase complete: ${ok} pulled, ${skip} skipped, ${fail} failed. Rebuilding payload…`);
try {
  // FIXED 23 Jul 2026 (production-readiness audit): this script only backfills COMPLETE historical
  // months (targets start at last month and go further back), so `targets[targets.length - 1]` is
  // never the real in-progress current month. Rebuilding portal_payload against that value silently
  // relabels the whole portal to the most recent BACKFILLED closed month until the next normal pull/
  // rebuild cycle happens to correct it. Match every other maintenance script instead: rebuild the
  // live payload for the actual current month + previous month, while still benefiting from the newly
  // backfilled history sitting behind it.
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const payload = await buildPayload(currentMonthStart, prevMonthStart);
  await admin.from('portal_payload').upsert({ id: 1, generated_at: new Date().toISOString(), payload });
  console.log(`Done. Payload now spans ${payload.months?.length || '?'} months.`);
} catch (e) { console.error('Payload rebuild failed (data is saved; run `npm run rebuild`):', e.message); }
process.exit(fail > ok ? 1 : 0);
