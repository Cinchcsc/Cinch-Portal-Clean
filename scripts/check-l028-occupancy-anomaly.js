// Task #197 — L028 (Edmonton) shows occ:0/rate:0 for the current month in the live portal despite
// 16 real RentRoll rows existing for the site. occ (occupied_units) and tot (total_units) both come
// SOLELY from the OccupancyStatistics report (lib/reportMap.js's `occupancy` parser) — rent_roll is a
// completely separate report/parser. If OccupancyStatistics returns ZERO rows for L028 (e.g. a brand-
// new site whose stats snapshot hasn't been generated yet on SiteLink's side, or a report-availability
// lag distinct from RentRoll's live per-unit view), occupancy.parse([]) legitimately produces
// total_units:0/occupied_units:0 with no error thrown anywhere -- callReport() treats SiteLink's own
// "no data" return code (-1) as a clean empty result, not a failure. `rate` (plain Rate) is a SEPARATE
// field entirely (rr.rate_per_sqft_ann, from RentRoll) -- if RentRoll's 16 rows exist but this reads 0
// too, that points at the 16 rows themselves lacking StandardRate/Area data (e.g. units not yet fully
// configured with a rate in SiteLink), not a parsing bug in this codebase.
// This checks, in order: (1) what's actually STORED right now for L028 (occupancy + rent_roll, no live
// call), (2) a FRESH LIVE OccupancyStatistics call for L028 (does SiteLink itself have stats for this
// site yet?), (3) a FRESH LIVE RentRoll call for L028 (do the 16 rows have real Area/StandardRate?),
// and (4) the same LIVE OccupancyStatistics call for L001 (Bicester) as a control, to confirm the code
// path itself works and isolate this to being L028-specific rather than a broken script/connection.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-l028-occupancy-anomaly.js
import { admin } from '../lib/supabaseAdmin.js';
import { callReport } from '../lib/sitelink.js';
import { checkPullLock } from '../lib/pullLock.js';

const num = (row, ...keys) => {
  for (const k of keys) {
    if (row && row[k] != null && row[k] !== '') {
      const n = Number(String(row[k]).replace(/[£,%\s]/g, ''));
      if (!Number.isNaN(n)) return n;
    }
  }
  return 0;
};
const yes = (v) => v === true || v === 'true' || v === 1 || v === '1';

const now = new Date();
const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
const monthKey = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, '0')}-01`;

console.log(`=== Step 1: what's STORED right now for L028, month=${monthKey} (no live calls) ===\n`);
for (const report of ['occupancy', 'rent_roll']) {
  const { data, error } = await admin
    .from('raw_report').select('data,pulled_at').eq('report', report).eq('site_code', 'L028').eq('month', monthKey).maybeSingle();
  if (error) { console.log(`  ${report}: read error — ${error.message}`); continue; }
  if (!data) { console.log(`  ${report}: NO STORED ROW for ${monthKey}.`); continue; }
  let d = data.data;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch {} }
  console.log(`  ${report}: pulled_at=${data.pulled_at}`);
  if (report === 'occupancy') {
    console.log(`    total_units=${d?.total_units}, occupied_units=${d?.occupied_units}, rate_per_sqft_ann=${d?.rate_per_sqft_ann}`);
  } else {
    console.log(`    rate_per_sqft_ann=${d?.rate_per_sqft_ann}, rent_sum=${d?.rent_sum}, std_rent_sum=${d?.std_rent_sum}, area_sum=${d?.area_sum}`);
  }
}

const lock = await checkPullLock();
if (lock.locked) {
  console.log(`\n[check-l028-occupancy-anomaly] ${lock.message} -- skipping live SiteLink calls (steps 2-4), stored-data check above still stands.`);
  process.exit(0);
}

console.log(`\n=== Step 2: FRESH LIVE OccupancyStatistics call for L028, ${monthStart.toDateString()} -> ${now.toDateString()} ===\n`);
const occLive = await callReport('OccupancyStatistics', 'L028', monthStart, now);
console.log(`  rows returned: ${occLive.rows.length}`);
if (occLive.rows.length) {
  console.log(`  sample row:`, JSON.stringify(occLive.rows[0]));
  const totUnits = occLive.rows.reduce((a, r) => a + num(r, 'TotalUnits'), 0);
  const occUnits = occLive.rows.reduce((a, r) => a + num(r, 'Occupied'), 0);
  console.log(`  summed TotalUnits=${totUnits}, Occupied=${occUnits}`);
} else {
  console.log(`  EMPTY -- SiteLink itself has no OccupancyStatistics data for L028 this period (retCode -1 or a genuinely empty dataset). This would fully explain occ:0/tot:0 with no code bug involved.`);
}

console.log(`\n=== Step 3: FRESH LIVE RentRoll call for L028 (same window) ===\n`);
const rrLive = await callReport('RentRoll', 'L028', monthStart, now);
console.log(`  rows returned: ${rrLive.rows.length}`);
const occRows = rrLive.rows.filter((r) => yes(r.bRented));
console.log(`  occupied (bRented) rows: ${occRows.length}`);
if (occRows.length) {
  const totalArea = occRows.reduce((a, r) => a + num(r, 'Area', 'Area1'), 0);
  const totalStd = occRows.reduce((a, r) => a + num(r, 'dcStdRate', 'dcStandardRate'), 0);
  console.log(`  summed Area=${totalArea}, summed dcStdRate=${totalStd}`);
  console.log(`  implied rate_per_sqft_ann = ${totalArea ? ((totalStd / totalArea) * 12).toFixed(2) : '0 (zero area!)'}`);
  const zeroArea = occRows.filter((r) => num(r, 'Area', 'Area1') === 0).length;
  const zeroRate = occRows.filter((r) => num(r, 'dcStdRate', 'dcStandardRate') === 0).length;
  if (zeroArea || zeroRate) console.log(`  NOTE: ${zeroArea} occupied row(s) with Area=0, ${zeroRate} occupied row(s) with dcStdRate=0 -- units not yet fully set up in SiteLink would look exactly like this.`);
  console.log(`  sample occupied row:`, JSON.stringify(occRows[0]));
} else {
  console.log(`  No occupied rows found live either -- the "16 live RentRoll rows" may have been all-unit (incl. vacant) count, or something has changed since that was last checked.`);
}

console.log(`\n=== Step 4: control -- same LIVE OccupancyStatistics call for L001 (Bicester, known-good) ===\n`);
const controlLive = await callReport('OccupancyStatistics', 'L001', monthStart, now);
console.log(`  rows returned: ${controlLive.rows.length} ${controlLive.rows.length ? '(code path works normally elsewhere -- L028 is isolated to that site, not a broken script/connection)' : '(unexpected -- L001 should never be empty; investigate the SiteLink connection itself first)'}`);

process.exit(0);
