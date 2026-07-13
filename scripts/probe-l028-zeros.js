// Task #98 follow-up: after repulling lead_funnel + npm run rebuild, L028 (Edmonton) still shows 0s
// while L029 (Abingdon) -- repulled via the exact same two commands -- looks correct. Since both
// went through an identical process, whatever's different has to be either a site-config gap (L028
// missing from SITELINK_LOCATIONS, or missing raw_report rows for report types other than
// lead_funnel because it's a newer site added after earlier full pulls -- see task #68) or a live
// SiteLink-side problem specific to this site code. Checks both, using L029 as a working control.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-l028-zeros.js
import { admin } from '../lib/supabaseAdmin.js';
import { callReport } from '../lib/sitelink.js';

const SITES = ['L028', 'L029'];

console.log('=== SITELINK_LOCATIONS env check ===');
const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
for (const s of SITES) console.log(`  ${s} in SITELINK_LOCATIONS: ${locations.includes(s)}`);
console.log(`  (total configured sites: ${locations.length})\n`);

console.log('=== sites table ===');
const { data: siteRows, error: siteErr } = await admin.from('sites').select('*').in('code', SITES);
if (siteErr) console.log('  ERROR:', siteErr.message);
else for (const s of SITES) {
  const row = siteRows.find((r) => r.code === s);
  console.log(`  ${s}: ${row ? JSON.stringify(row) : 'NO ROW FOUND'}`);
}

console.log('\n=== raw_report coverage (this month + last month) ===');
const now = new Date();
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
const thisMonth = monthKey(now);
const lastMonth = monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
for (const s of SITES) {
  const { data: rows, error } = await admin.from('raw_report').select('report,month,pulled_at,data').eq('site_code', s).in('month', [thisMonth, lastMonth]);
  if (error) { console.log(`  ${s}: ERROR ${error.message}`); continue; }
  console.log(`  ${s}: ${rows.length} raw_report rows across ${thisMonth}/${lastMonth}`);
  for (const r of rows.sort((a, b) => a.report.localeCompare(b.report))) {
    const dataSize = r.data ? (Array.isArray(r.data) ? r.data.length : Object.keys(r.data).length) : 0;
    console.log(`    ${r.report} / ${r.month} — pulled_at=${r.pulled_at}, data size=${dataSize}`);
  }
}

console.log('\n=== portal_payload sites array ===');
const { data: pp, error: ppErr } = await admin.from('portal_payload').select('payload').eq('id', 1).single();
if (ppErr) console.log('  ERROR:', ppErr.message);
else {
  for (const s of SITES) {
    const site = pp.payload?.sites?.find((x) => x.code === s);
    console.log(`  ${s}: ${site ? JSON.stringify({ name: site.name, occ: site.occ, tot: site.tot, rate: site.rate, enquiries: site.enquiries }) : 'MISSING FROM payload.sites ENTIRELY'}`);
  }
}

console.log('\n=== live direct SiteLink calls (bypass storage entirely) ===');
const start = new Date(now.getFullYear(), now.getMonth(), 1);
for (const s of SITES) {
  try {
    const { rows } = await callReport('RentRoll', s, start, now);
    console.log(`  ${s} RentRoll: ${rows.length} rows live right now`);
  } catch (e) {
    console.log(`  ${s} RentRoll: FAILED — ${e.message}`);
  }
}
process.exit(0);
