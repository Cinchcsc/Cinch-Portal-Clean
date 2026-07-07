// Offices occupancy is showing 89/188 vs the legacy portal's 75/89, and Self Storage is showing
// 7750/12356 vs 7706/12306 (small ~50-unit overage). Both come from OccupancyStatistics's per-
// UnitType breakdown (lib/reportMap.js's occupancy parser groups rows into `unit_types` by the
// UnitType column; buildPayload.js's `offices` field is `unit_types.find(t => /office/i.test(...))`
// — only the FIRST matching type per site, not a sum). This dumps every distinct UnitType label and
// its occ/tot across ALL sites (current month, straight from stored raw_report, no SiteLink call),
// so we can see whether: (a) more than one label matches /office/i per site (find() only keeps the
// first — could be picking the wrong/an incomplete one), (b) a label that SHOULDN'T count as
// "Office" is slipping through the regex, or (c) Self Storage's small overage comes from an extra
// label variant beyond "Indoor Self Storage".
// PII-SAFE: unit-type labels + counts only, no tenant data.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-offices.js
import { admin } from '../lib/supabaseAdmin.js';

const { data, error } = await admin.from('raw_report')
  .select('site_code,month,data').eq('report', 'occupancy')
  .order('month', { ascending: false });
if (error) { console.log('err', error.message); process.exit(1); }
if (!data?.length) { console.log('no occupancy rows stored.'); process.exit(0); }

const latestMonth = data[0].month;
const rows = data.filter(r => r.month === latestMonth);
console.log(`month: ${latestMonth}  (${rows.length} site rows)\n`);

const isOffice = (t) => /office/i.test(t || '');
const isSS = (t) => /self.?storage/i.test(t || '');

const officeLabels = new Set(), ssLabels = new Set();
let findOffOcc = 0, findOffTot = 0, sumOffOcc = 0, sumOffTot = 0;
let sumSSOcc = 0, sumSSTot = 0;

console.log('--- Per-site UnitType labels (only where >0 units) ---');
for (const r of rows) {
  const types = r.data?.unit_types || [];
  const officeMatches = types.filter(t => isOffice(t.unit_type));
  const ssMatches = types.filter(t => isSS(t.unit_type));
  if (officeMatches.length > 1) console.log(`⚠ ${r.site_code}: ${officeMatches.length} DIFFERENT labels match /office/i: ${officeMatches.map(t => `"${t.unit_type}"(${t.occ}/${t.tot})`).join(', ')}`);
  const firstOffice = officeMatches[0];
  if (firstOffice) { findOffOcc += firstOffice.occ || 0; findOffTot += firstOffice.tot || 0; officeLabels.add(firstOffice.unit_type); }
  for (const m of officeMatches) { sumOffOcc += m.occ || 0; sumOffTot += m.tot || 0; }
  for (const m of ssMatches) { sumSSOcc += m.occ || 0; sumSSTot += m.tot || 0; ssLabels.add(m.unit_type); }
  for (const t of types) if (isOffice(t.unit_type) || isSS(t.unit_type)) console.log(`  ${r.site_code}: "${t.unit_type}"  occ=${t.occ}  tot=${t.tot}`);
}

console.log('\n--- Totals ---');
console.log(`Offices via current code (find-first-match, one label per site): occ=${findOffOcc} tot=${findOffTot}`);
console.log(`Offices via sum-ALL-matching-labels per site: occ=${sumOffOcc} tot=${sumOffTot}`);
console.log(`Target (legacy portal): occ=75 tot=89`);
console.log(`\nSelf Storage via sum-ALL-matching-labels: occ=${sumSSOcc} tot=${sumSSTot}`);
console.log(`Target (legacy portal): occ=7706 tot=12306`);
console.log(`\nDistinct office labels seen: ${[...officeLabels].join(', ') || '(none)'}`);
console.log(`Distinct self-storage labels seen: ${[...ssLabels].join(', ') || '(none)'}`);
process.exit(0);
