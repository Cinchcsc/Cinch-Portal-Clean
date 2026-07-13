// Narrows down the last remaining variable. probe-truerevenue-staleness.js confirmed TruePeriod
// (the numerator) is essentially identical stored vs. live (<0.5% on 5 of 6 sites) -- so the big
// swings between my live recomputes and the portal's displayed numbers can't be the numerator. The
// one thing not yet checked: rent_roll's total_area_all_units (the DENOMINATOR) -- it may have a
// different pulled_at than true_revenue (separate reports, possibly pulled at different times, and
// rent_roll just went through a gap-backfill pass today). This computes the FULL Real Rate both ways
// (100% stored vs 100% live) for the same sites side by side, so whichever input is actually driving
// the mismatch shows up directly instead of being inferred.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-realrate-stored-vs-live.js
import { admin } from '../lib/supabaseAdmin.js';
import { callReport, callCustomReport } from '../lib/sitelink.js';
import { checkPullLock } from '../lib/pullLock.js';

const lock = await checkPullLock();
if (lock.locked) { console.error('[probe-realrate-stored-vs-live.js] ' + lock.message); process.exit(1); }

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
const TARGETS = { L001: 6.88, L005: 6.59, L008: 4.48, L012: 7.81, L023: 3.03, L027: 2.98 };

for (const [loc, target] of Object.entries(TARGETS)) {
  // --- stored ---
  const { data: rrStoredRows } = await admin.from('raw_report').select('data,pulled_at').eq('site_code', loc).eq('month', monthKey).eq('report', 'rent_roll').limit(1);
  const { data: trStoredRows } = await admin.from('raw_report').select('data,pulled_at').eq('site_code', loc).eq('month', monthKey).eq('report', 'true_revenue').limit(1);
  const rrStored = rrStoredRows?.[0], trStored = trStoredRows?.[0];
  const storedArea = rrStored?.data?.total_area_all_units || 0;
  const storedTruePeriod = (trStored?.data?.by_type || []).reduce((a, r) => a + (r.truePeriod || 0), 0);
  const storedRate = storedArea ? +((storedTruePeriod / storedArea) * 12).toFixed(2) : 0;
  const rrAgeH = rrStored ? ((Date.now() - new Date(rrStored.pulled_at).getTime()) / 3600000).toFixed(1) : 'n/a';
  const trAgeH = trStored ? ((Date.now() - new Date(trStored.pulled_at).getTime()) / 3600000).toFixed(1) : 'n/a';

  // --- live ---
  const { rows: rrLiveRows } = await callReport('RentRoll', loc, start, now);
  const liveArea = rrLiveRows.reduce((a, r) => a + num(r, 'Area', 'Area1'), 0);
  const { rows: trLiveRows } = await callCustomReport(781861, loc, start, now);
  const liveTruePeriod = trLiveRows.reduce((a, r) => a + num(r, 'TruePeriod'), 0);
  const liveRate = liveArea ? +((liveTruePeriod / liveArea) * 12).toFixed(2) : 0;

  const storedDiff = target ? (((storedRate - target) / target) * 100).toFixed(1) : 'n/a';
  const liveDiff = target ? (((liveRate - target) / target) * 100).toFixed(1) : 'n/a';

  console.log(`${loc} (target £${target}):`);
  console.log(`  STORED: area=${storedArea} (rent_roll pulled ${rrAgeH}h ago), truePeriod=£${storedTruePeriod.toFixed(2)} (true_revenue pulled ${trAgeH}h ago) -> Real Rate £${storedRate} (${storedDiff}%)`);
  console.log(`  LIVE:   area=${liveArea}, truePeriod=£${liveTruePeriod.toFixed(2)} -> Real Rate £${liveRate} (${liveDiff}%)`);
  console.log(`  area diff: ${liveArea - storedArea} ft² (${storedArea ? (((liveArea - storedArea) / storedArea) * 100).toFixed(1) : 'n/a'}%)\n`);
}
process.exit(0);
