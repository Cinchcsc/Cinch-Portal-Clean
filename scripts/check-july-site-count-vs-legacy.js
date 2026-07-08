// Michael flagged (8 Jul 2026) that our portal's Occupied Units card (8,465 / 13,504) doesn't match
// legacy's Total Store Occupancy total row (8,478 / 13,355) for Jul 2026. Total capacity differs by
// 149 units (~1.1%) — unlike Move-ins/Move-outs' small gaps (2-3%, explained by both sides being live
// MTD counters read at slightly different moments today), a site's TOTAL capacity doesn't fluctuate
// hour to hour, so a 149-unit gap in total_units points at a SITE-COVERAGE difference, not timing noise.
// Legacy's Total Store Occupancy table lists exactly 26 named sites for Jul 2026. Our system has been
// carrying 27 (confirmed multiple times this session, e.g. check-month-site-coverage.js). This is the
// still-open question from task #69 ("confirm Bedford/Paulton active status") — this script pins down
// EXACTLY which site is the extra one and what its own total_units is, instead of guessing further.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-july-site-count-vs-legacy.js
import { admin } from '../lib/supabaseAdmin.js';

// Exactly the 26 site names visible in legacy's "Total Store Occupancy" table, Jul 2026 (read directly
// off the live legacy portal screenshot Michael's comparing against).
const LEGACY_26 = [
  'Bicester', 'Leighton Buzzard', 'Letchworth', 'Chippenham', 'Brighton', 'Huntingdon', 'Newmarket',
  'Enfield', 'Mitcham', 'Sittingbourne', 'Gillingham', 'Brentwood', 'Earlsfield', 'Watford', 'Seaford',
  'Woking', 'Sidcup', 'Dunstable', 'Southend', 'Newbury', 'Swindon', 'Wisbech', 'Newcastle', 'Exeter',
  'Shoreham-By-Sea', 'Abingdon',
];
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const legacySet = new Set(LEGACY_26.map(norm));

const { data: sitesRef } = await admin.from('sites').select('code,name');
const nameOf = Object.fromEntries((sitesRef || []).map((s) => [s.code, s.name]));

const { data: occRows, error } = await admin.from('raw_report').select('site_code,data').eq('report', 'occupancy').eq('month', '2026-07-01').order('site_code');
if (error) { console.error(error.message); process.exit(1); }

console.log(`${occRows.length} sites have a Jul 2026 occupancy row in our system. Legacy's table lists ${LEGACY_26.length}.\n`);

let ourTotalUnits = 0, ourOccupied = 0;
const rows = [];
for (const r of occRows) {
  const tu = (r.data && r.data.total_units) || 0;
  const occ = (r.data && r.data.occupied_units) || 0;
  ourTotalUnits += tu; ourOccupied += occ;
  const name = nameOf[r.site_code] || r.site_code;
  rows.push({ code: r.site_code, name, tu, occ, inLegacy: legacySet.has(norm(name)) });
}

console.log(`Our summed Jul 2026 total_units: ${ourTotalUnits}   (legacy total row: 13,355 — diff ${ourTotalUnits - 13355})`);
console.log(`Our summed Jul 2026 occupied:    ${ourOccupied}   (legacy total row: 8,478 — diff ${ourOccupied - 8478})\n`);

const extras = rows.filter((r) => !r.inLegacy);
const missing = LEGACY_26.filter((n) => !rows.some((r) => norm(r.name) === norm(n)));

if (extras.length) {
  console.log(`Site(s) in OUR system NOT in legacy's 26-site list (the likely source of the total_units gap):`);
  for (const e of extras) console.log(`  ${e.code} / "${e.name}"  total_units=${e.tu}  occupied=${e.occ}`);
} else {
  console.log('No extra sites found by name-match — every one of our sites matches a legacy name.');
}
if (missing.length) {
  console.log(`\nLegacy site name(s) with NO match in our system:`);
  for (const m of missing) console.log(`  "${m}"`);
}
if (!extras.length && !missing.length) {
  console.log('\nSite lists match 1:1 by name — the total_units gap is NOT a coverage/count difference.');
  console.log('Would need to compare per-site total_units values directly against legacy\'s own per-site');
  console.log('table (each row in the screenshot) to find which individual site(s) disagree.');
}
process.exit(0);
