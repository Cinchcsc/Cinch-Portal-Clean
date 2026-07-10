// Task #67 — the now-deleted check-total-rate-zero.js originally found this: for L009 (Newbury),
// Mar-Dec 2022 (9 months), Occupancy Statistics shows real occupied units, but our STORED RentRoll
// data has area_sum/total_area_all_units = 0 for the same 9 months. Since Rate/Real Rate/Area are
// RentRoll-only everywhere now (the Occupancy-Stats fallback was tried 7 Jul 2026 then explicitly
// reverted — "keep RentRoll as the sole source everywhere, even where it disagrees"), Newbury's
// Rate/Real Rate/Area show as 0 for this window on Month-on-Month right now.
// Before treating this as a permanent, accepted historical gap, Michael asked (10 Jul 2026,
// AskUserQuestion: "Investigate first") whether it's fixable — i.e. is this a genuinely empty/
// zero-area RentRoll response from SiteLink for this site+period (re-pulling would NOT help), or was
// our ORIGINAL historical pull simply bad/incomplete (a fresh live pull WOULD recover real data)?
// This queries SiteLink's live RentRoll API directly, right now, for L009 across all 9 months —
// same diagnostic pattern as probe-enfield-rentroll-live.js (an analogous "SiteLink limit vs. stale
// pull" question, already resolved that way for a different site+field).
// Makes 9 live SiteLink calls (one per month) — respects the shared pull lock like every other
// live-calling script (skip if a backfill/pull is currently running: check refresh_log's latest row).
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-l009-rentroll-2022.js
import { callReport } from '../lib/sitelink.js';
import { checkPullLock } from '../lib/pullLock.js';

const lock = await checkPullLock();
if (lock.locked) { console.error('[probe-l009-rentroll-2022] ' + lock.message); process.exit(1); }

const loc = 'L009'; // Newbury
const months = ['2022-03', '2022-04', '2022-05', '2022-06', '2022-07', '2022-08', '2022-09', '2022-10', '2022-11', '2022-12'];

console.log(`Querying LIVE SiteLink RentRoll for ${loc} (Newbury), Mar-Dec 2022, right now...\n`);

const num = (r, ...keys) => { for (const k of keys) { const v = r[k]; if (v !== undefined && v !== null && v !== '') { const n = Number(v); if (!isNaN(n)) return n; } } return 0; };
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? ''));

let anyRealArea = false;
const results = [];
for (const mk of months) {
  const [y, m] = mk.split('-').map(Number);
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 0);
  try {
    const { rows } = await callReport('RentRoll', loc, start, end);
    const totalArea = rows.reduce((a, r) => a + num(r, 'Area', 'Area1'), 0);
    const rentedRows = rows.filter((r) => yes(r.bRented));
    const rentedArea = rentedRows.reduce((a, r) => a + num(r, 'Area', 'Area1'), 0);
    results.push({ mk, rowCount: rows.length, rentedCount: rentedRows.length, totalArea, rentedArea });
    if (totalArea > 0) anyRealArea = true;
    console.log(`  ${mk}: ${rows.length} rows (${rentedRows.length} rented) — total area ${totalArea}, rented area ${rentedArea}`);
  } catch (e) {
    results.push({ mk, error: e.message });
    console.log(`  ${mk}: FAILED — ${e.message}`);
  }
}

console.log('\n--- Conclusion ---');
if (!anyRealArea) {
  console.log('Even LIVE queries right now return zero area for L009 across all of Mar-Dec 2022.');
  console.log('This points to a genuine SiteLink-side gap for this site+period (unit data may not have');
  console.log('existed / been tracked in RentRoll form that far back, or the site was configured');
  console.log('differently then) — re-pulling would NOT recover anything. Recommend accepting this as a');
  console.log('documented historical gap: Newbury Rate/Real Rate/Area read 0 for Mar-Dec 2022 on');
  console.log('Month-on-Month, consistent with the RentRoll-only rule applied everywhere else.');
} else {
  const goodMonths = results.filter((r) => r.totalArea > 0).map((r) => r.mk);
  console.log(`LIVE queries DO return nonzero area for: ${goodMonths.join(', ')}`);
  console.log('Our STORED data for (at least) these months is stale/wrong — a targeted re-pull would fix it:');
  for (const mk of goodMonths) console.log(`  node --env-file=.env scripts/repull-report-month.js rent_roll ${mk}`);
  const stillZero = results.filter((r) => !r.error && r.totalArea === 0).map((r) => r.mk);
  if (stillZero.length) console.log(`\nStill zero even live (likely a genuine gap for just these months): ${stillZero.join(', ')}`);
}
process.exit(0);
