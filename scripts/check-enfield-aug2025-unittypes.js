// Michael flagged: Enfield (L008) shows £0 for Self Storage Rate and Self Storage Real Rate in Aug
// 2025, even though the site clearly has self-storage units (Occupancy Statistics shows 53/93 units
// under the "self storage" bucket that month, per /api/portfolio's `ss.occ`/`ss.tot`). The live API
// response shows officesRentSum/officesAreaSum EXACTLY equal to the site's total rentSum/areaSum for
// that month — meaning RentRoll's own unit-type breakdown put 100% of rent/area under "Office" and
// 0% under anything matching /self storage/i (lib/reportMap.js's `isSS` filter). This dumps Enfield's
// raw RentRoll unit_types array for Aug 2025 to see the exact type labels SiteLink returned that
// month, to tell whether this is the previously-investigated Occupancy-Statistics-vs-RentRoll typing
// mismatch (task #33, already understood/expected) or a genuine new data issue for this site/month.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-enfield-aug2025-unittypes.js
import { admin } from '../lib/supabaseAdmin.js';

const { data, error } = await admin
  .from('raw_report')
  .select('data, pulled_at')
  .eq('site_code', 'L008')
  .eq('report', 'rent_roll')
  .eq('month', '2025-08-01')
  .maybeSingle();
if (error) { console.error(error.message); process.exit(1); }
if (!data) { console.log('No rent_roll row found for L008 / 2025-08-01 at all.'); process.exit(0); }

console.log(`pulled_at: ${data.pulled_at}\n`);
console.log('unit_types (RentRoll per-type breakdown):');
console.log(JSON.stringify(data.data?.unit_types, null, 2));
console.log('\nself_storage sub-object (computed by isSS filter):');
console.log(JSON.stringify(data.data?.self_storage, null, 2));

// Also check a few OTHER months for the same site to see if this is Aug-2025-specific or affects
// every month for Enfield (i.e. a structural site-naming issue, not a one-month data blip).
console.log('\n--- Cross-check: does Enfield have a matching "self storage" unit_type in OTHER months? ---');
const testMonths = ['2025-06-01', '2026-01-01', '2026-06-01'];
for (const mk of testMonths) {
  const { data: row } = await admin.from('raw_report').select('data').eq('site_code', 'L008').eq('report', 'rent_roll').eq('month', mk).maybeSingle();
  const types = (row?.data?.unit_types || []).map((t) => t.unit_type);
  console.log(`${mk}: unit_type labels = ${JSON.stringify(types)}`);
}
process.exit(0);
