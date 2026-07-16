// Task: District Manager "Cockpit — Month to Date" widget shows Actual so far £764,656 vs 3-month
// avg pace £94,322 -- an ~8x gap where the two should be roughly comparable (both are portfolio-wide
// cumulative-by-day-of-month figures). lib/cockpitData.js computes the pace line by summing
// raw_report's stored 'financial' rows (one row per site per month) for the last 3 CLOSED months,
// dividing each month's portfolio total by days-in-month, then averaging those 3 daily rates.
// HYPOTHESIS: only a fraction of the 29 sites actually have a stored 'financial' raw_report row for
// those 3 past months (a pull/coverage gap), so the "portfolio" monthly total used for the pace line
// is really just a handful of sites' totals, undercounting by roughly (29 / sites-with-data). This
// script queries raw_report directly (same table/filter cockpitData.js uses) and reports, for each
// of the last 3 closed months: how many distinct sites have a 'financial' row, which of the 29 are
// MISSING, and the resulting daily rate -- to confirm or rule out the coverage-gap hypothesis before
// touching any code.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-cockpit-pace-coverage.js
import { admin } from '../lib/supabaseAdmin.js';

const ALL_SITES = ['L001', 'L002', 'L003', 'L004', 'L005', 'L006', 'L007', 'L008', 'L009', 'L010', 'L011', 'L012', 'L013', 'L014', 'L015', 'L016', 'L017', 'L018', 'L019', 'L020', 'L021', 'L022', 'L023', 'L024', 'L025', 'L026', 'L027', 'L028', 'L029'];
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();

const now = new Date();
const closedMonths = [];
for (let i = 1; i <= 3; i++) {
  const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
  closedMonths.push({ y: d.getFullYear(), m: d.getMonth(), key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01` });
}

console.log(`Checking raw_report coverage for report='financial' across the last 3 closed months: ${closedMonths.map((c) => c.key).join(', ')}\n`);

const dailyRates = [];
for (const c of closedMonths) {
  const { data: rows, error } = await admin
    .from('raw_report').select('site_code,month,data')
    .eq('report', 'financial')
    .eq('month', c.key);
  if (error) { console.error(`  ${c.key}: query FAILED — ${error.message}`); continue; }

  const bySite = {};
  for (const r of rows || []) {
    const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    bySite[r.site_code] = (bySite[r.site_code] || 0) + (Number(d?.total_charge) || 0);
  }
  const sitesWithData = Object.keys(bySite);
  const missing = ALL_SITES.filter((s) => !sitesWithData.includes(s));
  const monthTotal = Object.values(bySite).reduce((a, b) => a + b, 0);
  const days = daysInMonth(c.y, c.m);
  const dailyRate = monthTotal / days;
  dailyRates.push(dailyRate);

  console.log(`--- ${c.key} ---`);
  console.log(`  Sites with a 'financial' row: ${sitesWithData.length} / ${ALL_SITES.length}`);
  if (missing.length) console.log(`  MISSING sites: ${missing.join(', ')}`);
  console.log(`  Portfolio total_charge (sites present only): £${monthTotal.toFixed(2)}`);
  console.log(`  Days in month: ${days}   Daily rate: £${dailyRate.toFixed(2)}/day`);
  console.log('');
}

const avgDailyRate = dailyRates.length ? dailyRates.reduce((a, b) => a + b, 0) / dailyRates.length : 0;
console.log(`Resulting avgDailyRate (matches cockpitData.js's own computation): £${avgDailyRate.toFixed(2)}/day`);
console.log(`If today is day N of the current month, the widget's "3-month avg pace" = avgDailyRate × N.`);
console.log(`Compare that against "Actual so far" on the live District Manager page -- if avgDailyRate`);
console.log(`is far below what full 29-site coverage would produce, the MISSING sites list above is why.`);
process.exit(0);
