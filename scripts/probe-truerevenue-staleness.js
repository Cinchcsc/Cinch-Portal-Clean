// Decisive follow-up: probe-truerevenue-tables-timing.js ruled out multi-table data loss (all 3
// tables sum identically) and second-to-second ticking (stable across 20-30s). But the portal never
// queries SiteLink live -- buildPayload.js reads whatever is STORED in raw_report from the last pull
// (this morning's cron, or whenever), while every probe script this session has queried SiteLink
// LIVE, right now. We're only 10 days into July, so month-to-date True Revenue is still small and
// each day's charges are a big fraction of the running total -- a stale stored snapshot could easily
// be double-digit % behind a fresh live pull. This measures that gap directly: for each site, compares
// the STORED true_revenue's Σ truePeriod (with its pulled_at timestamp) against a FRESH live pull's
// Σ TruePeriod done right now.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-truerevenue-staleness.js
import { admin } from '../lib/supabaseAdmin.js';
import { callCustomReport } from '../lib/sitelink.js';
import { checkPullLock } from '../lib/pullLock.js';

const lock = await checkPullLock();
if (lock.locked) { console.error('[probe-truerevenue-staleness] ' + lock.message); process.exit(1); }

const num = (row, ...keys) => {
  for (const k of keys) {
    if (row && row[k] != null && row[k] !== '') {
      const n = Number(String(row[k]).replace(/[£,%\s]/g, ''));
      if (!Number.isNaN(n)) return n;
    }
  }
  return 0;
};

const now = new Date();
const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
const start = new Date(now.getFullYear(), now.getMonth(), 1);

const SITES = ['L001', 'L005', 'L008', 'L012', 'L023', 'L027']; // spread of sites from the earlier mixed +/- results

for (const loc of SITES) {
  const { data: rows, error } = await admin.from('raw_report').select('data,pulled_at').eq('site_code', loc).eq('month', monthKey).eq('report', 'true_revenue').limit(1);
  if (error || !rows?.length) { console.log(`${loc}: no stored true_revenue row for ${monthKey} — ${error?.message || 'missing'}`); continue; }
  const stored = rows[0];
  const storedSum = (stored.data?.by_type || []).reduce((a, r) => a + (r.truePeriod || 0), 0);
  const hoursAgo = (Date.now() - new Date(stored.pulled_at).getTime()) / 3600000;

  const { rows: liveRows } = await callCustomReport(781861, loc, start, now);
  const liveSum = liveRows.reduce((a, r) => a + num(r, 'TruePeriod'), 0);

  const pctDiff = storedSum ? (((liveSum - storedSum) / storedSum) * 100).toFixed(1) : 'n/a';
  console.log(`${loc}: stored Σ truePeriod=£${storedSum.toFixed(2)} (pulled ${hoursAgo.toFixed(1)}h ago)  vs  live Σ TruePeriod=£${liveSum.toFixed(2)} right now  ->  ${pctDiff}% ${liveSum >= storedSum ? 'higher' : 'lower'} live`);
}
process.exit(0);
