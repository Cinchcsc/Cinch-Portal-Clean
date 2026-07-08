// Follow-up to the exhaustive June comparison (7 Jul 2026): /api/portfolio?from=2026-06&to=2026-06
// returns only 14 of the ~27 configured sites — and the 14 present are an exact contiguous block by
// code (L014-L027), with L001-L013 completely absent. That's not random noise; it looks like either
// (a) a genuine raw_report gap for June specific to those 13 site codes, or (b) some pull run for June
// that covered only "the second half" of SITELINK_LOCATIONS and never got back to fill in the rest.
// buildPayload.js's site filter is: `idx[code][mk] && idx[code][mk].occupancy && idx[code][mk]
// .occupancy.total_units > 0` — so a site drops out of the sites[] array entirely if its `occupancy`
// row for that month is missing (or has total_units 0), regardless of whether its OTHER reports
// (rent_roll, management, etc.) are fine. This directly skews every portfolio-wide sum/average for
// that month (rate, revenue, occupancy %, everything) toward whichever subset of sites happens to have
// occupancy data — which would fully explain "wrong rates" without any formula being incorrect.
// check-rentroll-gaps.js already exists but only checks MONTH-level presence (is a report missing for
// an ENTIRE month across all sites) — it can't see a per-site gap within a month that otherwise has
// data for most sites. This script checks SITE-level completeness for one specific month, across every
// report, so we can see exactly which (site, report) pairs are missing.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-month-site-coverage.js [YYYY-MM]
import { admin } from '../lib/supabaseAdmin.js';

const monthArg = process.argv[2] || '2026-06';
const monthKey = `${monthArg}-01`;
const ALL_REPORTS = ['occupancy', 'rent_roll', 'management', 'move_ins_outs', 'past_due', 'scheduled_outs',
  'insurance_roll', 'insurance_activity', 'lead_funnel', 'marketing', 'merchandise', 'financial', 'rate_changes',
  'reservations', 'true_revenue', 'rental_activity'];

const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!locations.length) { console.error('SITELINK_LOCATIONS not set'); process.exit(1); }
console.log(`Checking ${locations.length} configured sites x ${ALL_REPORTS.length} reports for month ${monthKey}...\n`);

const coverage = {}; // report -> Set(site_code)
for (const report of ALL_REPORTS) {
  const { data, error } = await admin.from('raw_report').select('site_code').eq('report', report).eq('month', monthKey);
  if (error) { console.error(`${report}: ${error.message}`); continue; }
  coverage[report] = new Set(data.map((r) => r.site_code));
}

console.log(`Report coverage (sites present / ${locations.length} configured):`);
for (const report of ALL_REPORTS) {
  const present = coverage[report] || new Set();
  console.log(`  ${report.padEnd(18)} ${present.size}/${locations.length}`);
}

// The specific gate buildPayload.js uses to include a site at all: occupancy present AND total_units > 0.
console.log(`\n--- occupancy detail (the report that gates whether a site appears at all) ---`);
const occPresent = coverage.occupancy || new Set();
const missingOcc = locations.filter((loc) => !occPresent.has(loc));
console.log(`Missing occupancy row entirely for ${monthKey}: ${missingOcc.length ? missingOcc.join(', ') : '(none)'}`);

if (missingOcc.length) {
  console.log(`\nThese ${missingOcc.length} sites will NEVER appear in sites[] for ${monthKey} until their occupancy row`);
  console.log(`is backfilled. Re-pull just occupancy for this month:`);
  console.log(`  node --env-file=.env scripts/repull-report-month.js occupancy ${monthArg}`);
}

// Also flag any site whose occupancy row exists but is otherwise incomplete for other reports.
console.log(`\n--- per-report gaps for sites that DO have occupancy ---`);
for (const report of ALL_REPORTS) {
  if (report === 'occupancy') continue;
  const present = coverage[report] || new Set();
  const missing = locations.filter((loc) => occPresent.has(loc) && !present.has(loc));
  if (missing.length) console.log(`  ${report}: missing for ${missing.join(', ')}`);
}
process.exit(0);
