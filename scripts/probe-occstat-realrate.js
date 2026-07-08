// Follow-up to probe-realrate-regression.js: NONE of RentRoll's fields (dcRent, dcStandardRate, or
// any permutation of area/annualisation) land anywhere near legacy's actual Real Rate for Bicester
// (£6.88) — best case was ~£26-29, an order of magnitude off, not "a few pence" like Michael says
// Friday's numbers were. That means Real Rate was probably never coming from RentRoll's dcStandardRate
// at all when it was correct.
// reportMap.js's OccupancyStatistics parser has its OWN asking/real rate pair, sourced from
// completely different columns (GrossOccupied / ActualOccupied), and its code comment literally says:
// "real_rate_per_sqft_ann: rate(actOcc, occArea), // Total real rate (live 'Real Rate' -> Total)" —
// i.e. this was written AS the thing meant to match legacy's live Real Rate. buildPayload.js's history
// shows a "revert the OccupancyStatistics fallback added 7 Jul 2026; keep RentRoll as the sole source"
// change — if that revert threw away the one part of the fallback that was actually correct, THIS is
// the regression. This pulls OccupancyStatistics live for Bicester and checks its asking/real rate
// against the same known target (Rate £28.50, Real Rate £6.88).
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-occstat-realrate.js [siteCode]
import { callReport } from '../lib/sitelink.js';
import { REPORTS } from '../lib/reportMap.js';

const loc = process.argv[2] || 'L001';
const start = new Date(2026, 6, 1);
let end = new Date(); if (end > new Date(2026, 6, 31)) end = new Date(2026, 6, 31);

const { rows } = await callReport('OccupancyStatistics', loc, start, end);
const p = REPORTS.occupancy.parse(rows);

console.log(`${loc} — OccupancyStatistics, Jul 2026, ${rows.length} rows\n`);
console.log('=== Every field on one sample row ===');
if (rows[0]) for (const [k, v] of Object.entries(rows[0])) console.log(`  ${k}: ${JSON.stringify(v)}`);

console.log('\n=== Parsed asking/real rate (Total, all unit types) ===');
console.log(`Total asking rate (rate_per_sqft_ann)       = £${p.rate_per_sqft_ann}   (legacy Total Rate: £28.50)`);
console.log(`Total real rate   (real_rate_per_sqft_ann)  = £${p.real_rate_per_sqft_ann}   (legacy Total Real Rate: £6.88)`);
console.log(`\n=== Self Storage only ===`);
console.log(`SS asking rate (self_storage_rate_ann)      = £${p.self_storage_rate_ann}   (legacy SS Rate: £29.98)`);
console.log(`SS real rate   (self_storage_real_rate_ann) = £${p.self_storage_real_rate_ann}   (legacy SS Real Rate: £7.24)`);
console.log(`\nunderlying sums: occupied_area=${p.occupied_area}  gross_occupied=${p.gross_occupied}  monthly_rent(actOcc)=${p.monthly_rent}`);
process.exit(0);
