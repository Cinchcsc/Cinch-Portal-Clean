// Task: Insurance Conversion gap (+4pp, ~89% ours vs legacy's 85%), flagged in the 15 Jul audit,
// not yet investigated. Mirrors the exact production formula (app/portal-v2/page.js, insConvPct):
// insNewCount (InsuranceRoll: active policies whose dMovedIn falls within the period) ÷ moveInsSum
// (MoveInsAndMoveOuts: all move-ins in the period), capped at 100%. Tests the same first hypothesis
// that fully explained Debtor Levels and Reservations: does excluding Bedford/Paulton/Exeter (sites
// legacy doesn't track) close some or all of the gap? Prints per-site contributions plus both a
// 29-site and 26-site total so the 26-site row can be compared directly against legacy's 85%.
// NOTE: the code's own comment on insConvPct already documents a real structural caveat even after
// scope is accounted for — InsuranceRoll's dMovedIn-based "new" and MoveInsAndMoveOuts' "new
// move-in" are independently-defined counts from two different reports with no shared tenant key,
// so some residual mismatch may be unfixable without a real per-tenant join field from SiteLink.
// This script only tests the scope hypothesis; it does not attempt to fix that structural caveat.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-insurance-conversion-scope.js
import { pullReport } from '../lib/reportMap.js';
import { checkPullLock } from '../lib/pullLock.js';

const lock = await checkPullLock();
if (lock.locked) { console.error('[probe-insurance-conversion-scope] ' + lock.message); process.exit(1); }

const NAMES = { L001: 'Bicester', L002: 'Leighton Buzzard', L003: 'Letchworth', L004: 'Chippenham', L005: 'Brighton', L006: 'Huntingdon', L007: 'Newmarket', L008: 'Enfield', L009: 'Newbury', L010: 'Mitcham', L011: 'Sittingbourne', L012: 'Gillingham', L013: 'Brentwood', L014: 'Earlsfield', L015: 'Watford', L016: 'Seaford', L017: 'Southend', L018: 'Woking', L019: 'Sidcup', L020: 'Dunstable', L021: 'Bedford', L022: 'Swindon', L023: 'Wisbech', L024: 'Newcastle', L025: 'Shoreham-By-Sea', L026: 'Paulton', L027: 'Exeter', L028: 'Edmonton', L029: 'Abingdon' };
const EXCLUDE = new Set(['L021', 'L026', 'L027']); // Bedford, Paulton, Exeter

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);

let totalInsNew = 0, totalMoveIns = 0, exclInsNew = 0, exclMoveIns = 0;

for (const [loc, name] of Object.entries(NAMES)) {
  try {
    const { data: insData } = await pullReport('insurance_roll', loc, start, now);
    const { data: mioData } = await pullReport('move_ins_outs', loc, start, now);

    const insNew = (insData.insured_new_customers && insData.insured_new_customers.count) || 0;
    const moveIns = mioData.move_ins || 0;

    totalInsNew += insNew; totalMoveIns += moveIns;
    if (!EXCLUDE.has(loc)) { exclInsNew += insNew; exclMoveIns += moveIns; }

    const pct = moveIns ? (insNew / moveIns * 100).toFixed(1) : '0.0';
    process.stderr.write(`  ${loc} ${name}${EXCLUDE.has(loc) ? ' [EXCLUDED]' : ''}: insNew=${insNew}, moveIns=${moveIns} (${pct}%)\n`);
  } catch (e) {
    console.error(`  ${loc}: FAILED — ${e.message}`);
  }
}

const cap = (n) => Math.min(100, n);
console.log(`\n--- Insurance Conversion (insNewCount ÷ moveInsSum, capped at 100%) ---`);
console.log(`All 29 sites:                          ${totalInsNew}/${totalMoveIns} = ${totalMoveIns ? cap(+(totalInsNew / totalMoveIns * 100).toFixed(1)) : 0}%`);
console.log(`26 sites (Bedford/Paulton/Exeter excl): ${exclInsNew}/${exclMoveIns} = ${exclMoveIns ? cap(+(exclInsNew / exclMoveIns * 100).toFixed(1)) : 0}%`);
console.log(`Compare the 26-site row directly to legacy's own widget (85%).`);
console.log(`\nIf the 26-site row is still meaningfully above 85%, the gap is NOT scope -- it's the`);
console.log(`structural mismatch already documented in page.js (InsuranceRoll's dMovedIn-based "new"`);
console.log(`vs MoveInsAndMoveOuts' "new move-in" are independently-defined, no shared tenant key).`);
process.exit(0);
