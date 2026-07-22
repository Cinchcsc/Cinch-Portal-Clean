// PROBE (22 Jul 2026), task #308/#403 — Michael supplied a June 2026 KPIs-page screenshot with exact
// Bicester unit counts: Total Store 314/348 occupied/total, Indoor Self Storage 276/304, Offices 4/4
// (Rate per ft² £28.57/£30.09 match already-confirmed targets, so this screenshot is internally
// consistent with everything established so far).
//
// probe-realrate-financialsummary-credit-exact.js's Real Rate came in near-exact for July (4p/1p) but
// ~£1 off for June, the FOURTH time this exact pattern has shown up regardless of which Credits/
// Discounts source is used — pointing away from "wrong report" and toward June's frozen RentRoll
// snapshot (read once from Supabase, back when June was still live, per pull.js's snapshot-freezing
// rule) not perfectly matching legacy's own final June state.
//
// This is a direct, cheap, decisive check: count occupied/total units in the SAME frozen June
// rent_roll raw_response already being used for every June test, split Total Store vs Indoor Self
// Storage vs Offices the same way the screenshot does, and compare straight against 314/348, 276/304,
// 4/4. If these don't match, the frozen snapshot itself is the problem, not the Real Rate formula.
//
// Run:  node --env-file=.env scripts/probe-june-frozen-unitcount-check.js [siteCode]
import { extractRows } from '../lib/sitelink.js';
import { admin } from '../lib/supabaseAdmin.js';

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-june-frozen-unitcount-check.js <siteCode>'); process.exit(1); }

const str = (v) => String(v ?? '').trim();
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? ''));
const isSS = (t) => /self.?storage/i.test(String(t || ''));
const isOffice = (t) => /^office$/i.test(String(t || '').trim());

const { data: rows, error } = await admin.from('raw_report').select('raw_response, pulled_at').eq('site_code', site).eq('month', '2026-06-01').eq('report', 'rent_roll').limit(1);
if (error) { console.error('Supabase error:', error.message); process.exit(1); }
if (!rows || !rows.length || !rows[0].raw_response) { console.error('No frozen June rent_roll found for this site.'); process.exit(1); }

console.log(`Frozen June rent_roll was pulled at: ${rows[0].pulled_at}`);
const rrRows = extractRows(rows[0].raw_response);
console.log(`Total raw rows: ${rrRows.length}\n`);

function summarize(filterFn) {
  let total = 0, occupied = 0, area = 0, occArea = 0;
  for (const r of rrRows) {
    if (!filterFn(r)) continue;
    total++;
    const a = num(r.Area ?? r.Area1);
    area += a;
    if (yes(r.bRented)) { occupied++; occArea += a; }
  }
  return { total, occupied, area: Math.round(area * 100) / 100, occArea: Math.round(occArea * 100) / 100 };
}

const totalStore = summarize(() => true);
const ss = summarize((r) => isSS(r.sTypeName));
const offices = summarize((r) => isOffice(r.sTypeName));

console.log('=== Comparison against Michael\'s June 2026 KPIs screenshot ===\n');
console.log(`Total Store:          our frozen data: ${totalStore.occupied}/${totalStore.total} occupied/total   (screenshot: 314/348)   ${totalStore.occupied === 314 && totalStore.total === 348 ? 'MATCH' : 'MISMATCH'}`);
console.log(`  occupied area=${totalStore.occArea} sqft, total area=${totalStore.area} sqft`);
console.log(`Indoor Self Storage:  our frozen data: ${ss.occupied}/${ss.total} occupied/total   (screenshot: 276/304)   ${ss.occupied === 276 && ss.total === 304 ? 'MATCH' : 'MISMATCH'}`);
console.log(`  occupied area=${ss.occArea} sqft, total area=${ss.area} sqft`);
console.log(`Offices:              our frozen data: ${offices.occupied}/${offices.total} occupied/total   (screenshot: 4/4)   ${offices.occupied === 4 && offices.total === 4 ? 'MATCH' : 'MISMATCH'}`);
console.log(`  occupied area=${offices.occArea} sqft, total area=${offices.area} sqft`);

console.log(`\n${'='.repeat(74)}`);
if (totalStore.occupied === 314 && totalStore.total === 348) {
  console.log('Unit counts MATCH the screenshot exactly -- the frozen snapshot is NOT\nstale/wrong on occupancy. The ~£1 June Real Rate gap is not explained by a\nbad snapshot; it must be something else (worth re-examining the actual\nCredits/Discounts figures or Rent numerator itself for June specifically).');
} else {
  console.log(`Unit counts DO NOT match (our data: ${totalStore.occupied}/${totalStore.total}, screenshot: 314/348)\n-- the frozen June snapshot itself is off. This would explain the residual\nReal Rate gap without needing another Credits/Discounts source at all --\nthe snapshot may have been captured at the wrong moment (task pull.js's\n"freeze once, while still current" rule may have fired a day or two early\nor late relative to June's true final state).`);
}
console.log('='.repeat(74));
process.exit(0);
