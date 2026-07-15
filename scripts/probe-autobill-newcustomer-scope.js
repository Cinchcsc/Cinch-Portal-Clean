// Task #228 (Autobill Conversion), correction. probe-reservations-autobill-scope.js's Autobill
// number (81.3%/81.1%, barely moved by excluding Bedford/Paulton/Exeter) tested the WRONG formula:
// rr.autobill_count / rr.tenants — buildPayload.js's own comment on that exact pair (line 152) says
// "raw sums for the OLD whole-book autobill % (kept for back-compat, no longer used by the Autobill
// Conversion widget)". The REAL widget (buildPayload.js lines 162-168, confirmed 2 Jul 2026 from
// legacy's own tooltip — "new autobilled customers / total new customers") is scoped to THIS MONTH'S
// move-ins only: cross-reference move_ins_outs' move_in_tenant_ids against rent_roll's
// autobill_tenant_ids. Production also smooths this with a daily-average (autobill_daily table,
// applyAutobillDailyAverage() in buildPayload.js) — that part can't be replicated here without the
// historical sample table, so this script only reproduces the single-point-in-time cross-reference
// (the same fallback buildPayload.js itself uses for any month with zero collected daily samples).
// Prints both the all-29-site and 26-site (Bedford/Paulton/Exeter excluded) totals so the corrected
// number can be compared directly against legacy's 75%.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-autobill-newcustomer-scope.js
import { pullReport } from '../lib/reportMap.js';
import { checkPullLock } from '../lib/pullLock.js';

const lock = await checkPullLock();
if (lock.locked) { console.error('[probe-autobill-newcustomer-scope] ' + lock.message); process.exit(1); }

const NAMES = { L001: 'Bicester', L002: 'Leighton Buzzard', L003: 'Letchworth', L004: 'Chippenham', L005: 'Brighton', L006: 'Huntingdon', L007: 'Newmarket', L008: 'Enfield', L009: 'Newbury', L010: 'Mitcham', L011: 'Sittingbourne', L012: 'Gillingham', L013: 'Brentwood', L014: 'Earlsfield', L015: 'Watford', L016: 'Seaford', L017: 'Southend', L018: 'Woking', L019: 'Sidcup', L020: 'Dunstable', L021: 'Bedford', L022: 'Swindon', L023: 'Wisbech', L024: 'Newcastle', L025: 'Shoreham-By-Sea', L026: 'Paulton', L027: 'Exeter', L028: 'Edmonton', L029: 'Abingdon' };
const EXCLUDE = new Set(['L021', 'L026', 'L027']); // Bedford, Paulton, Exeter

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);

let totalNewCount = 0, totalNewTotal = 0, exclNewCount = 0, exclNewTotal = 0;

for (const [loc, name] of Object.entries(NAMES)) {
  try {
    const { data: rrData } = await pullReport('rent_roll', loc, start, now);
    const { data: mioData } = await pullReport('move_ins_outs', loc, start, now);

    const moveInIds = Array.isArray(mioData.move_in_tenant_ids) ? mioData.move_in_tenant_ids : [];
    const autobillIds = new Set(rrData.autobill_tenant_ids || []);
    const newCount = moveInIds.filter((id) => autobillIds.has(id)).length;
    const newTotal = moveInIds.length;

    totalNewCount += newCount; totalNewTotal += newTotal;
    if (!EXCLUDE.has(loc)) { exclNewCount += newCount; exclNewTotal += newTotal; }

    process.stderr.write(`  ${loc} ${name}${EXCLUDE.has(loc) ? ' [EXCLUDED]' : ''}: autobillNew=${newCount}/${newTotal} (${newTotal ? (newCount / newTotal * 100).toFixed(1) : '0.0'}%)\n`);
  } catch (e) {
    console.error(`  ${loc}: FAILED — ${e.message}`);
  }
}

console.log(`\n--- Autobill Conversion (new-customer-scoped, matches production formula minus daily-average smoothing) ---`);
console.log(`All 29 sites:                          ${totalNewCount}/${totalNewTotal} = ${totalNewTotal ? (totalNewCount / totalNewTotal * 100).toFixed(1) : '0.0'}%`);
console.log(`26 sites (Bedford/Paulton/Exeter excl): ${exclNewCount}/${exclNewTotal} = ${exclNewTotal ? (exclNewCount / exclNewTotal * 100).toFixed(1) : '0.0'}%`);
console.log(`Compare the 26-site row directly to legacy's own widget (75%).`);
console.log(`\nNote: production also applies a daily-average smoothing on top of this single-point cross-`);
console.log(`reference (see buildPayload.js's applyAutobillDailyAverage) -- if this figure is still off,`);
console.log(`the daily-average table itself would be the next place to check, not this cross-reference logic.`);
process.exit(0);
