// Tasks: Scheduled Reservations vs Scheduled Move-outs gap (281 ours vs 222 legacy, +26.6%) and
// Autobill Conversion gap (79.6% ours vs 75% legacy, +4.6pp) / Insurance Conversion gap (89% vs 85%,
// +4pp) -- flagged in the 15 Jul portal-vs-legacy audit, not yet investigated. Debtor Levels' £2,952
// gap turned out to be 100% explained by Bedford/Paulton/Exeter (sites we track that legacy doesn't)
// -- this checks whether the SAME explanation covers these three, by printing each of those 3 sites'
// own contribution to Scheduled Move-outs / Active Reservations / Autobill count / occupied tenants,
// so we can subtract them out and compare like-for-like against legacy's 26-site figures directly,
// the same way the Debtor Levels check worked.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-reservations-autobill-scope.js
import { pullReport } from '../lib/reportMap.js';
import { checkPullLock } from '../lib/pullLock.js';

const lock = await checkPullLock();
if (lock.locked) { console.error('[probe-reservations-autobill-scope] ' + lock.message); process.exit(1); }

const NAMES = { L001: 'Bicester', L002: 'Leighton Buzzard', L003: 'Letchworth', L004: 'Chippenham', L005: 'Brighton', L006: 'Huntingdon', L007: 'Newmarket', L008: 'Enfield', L009: 'Newbury', L010: 'Mitcham', L011: 'Sittingbourne', L012: 'Gillingham', L013: 'Brentwood', L014: 'Earlsfield', L015: 'Watford', L016: 'Seaford', L017: 'Southend', L018: 'Woking', L019: 'Sidcup', L020: 'Dunstable', L021: 'Bedford', L022: 'Swindon', L023: 'Wisbech', L024: 'Newcastle', L025: 'Shoreham-By-Sea', L026: 'Paulton', L027: 'Exeter', L028: 'Edmonton', L029: 'Abingdon' };
const EXCLUDE = new Set(['L021', 'L026', 'L027']); // Bedford, Paulton, Exeter -- match audit's comparison scope

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);

let totalScheduledOuts = 0, totalActiveRes = 0, totalAutobill = 0, totalOccTenants = 0, totalInsuredNew = 0, totalMoveIns = 0;
let exclScheduledOuts = 0, exclActiveRes = 0, exclAutobill = 0, exclOccTenants = 0;

for (const [loc, name] of Object.entries(NAMES)) {
  try {
    const { data: rrData } = await pullReport('rent_roll', loc, start, now);
    const { data: resData } = await pullReport('reservations', loc, start, now);
    const { data: soData } = await pullReport('scheduled_outs', loc, start, now);

    const occupiedIds = new Set(rrData.occupied_tenant_ids || []);
    const activeIds = Array.isArray(resData.active_tenant_ids) ? resData.active_tenant_ids : [];
    const activeReservations = activeIds.length ? activeIds.filter((id) => !occupiedIds.has(id)).length : (resData.active_reservations || 0);
    const scheduledOuts = soData.scheduled_move_outs || 0;
    const autobillCount = rrData.autobill_count || 0;
    const occTenants = rrData.tenants || 0;

    totalScheduledOuts += scheduledOuts; totalActiveRes += activeReservations; totalAutobill += autobillCount; totalOccTenants += occTenants;
    if (!EXCLUDE.has(loc)) { exclScheduledOuts += scheduledOuts; exclActiveRes += activeReservations; exclAutobill += autobillCount; exclOccTenants += occTenants; }

    process.stderr.write(`  ${loc} ${name}${EXCLUDE.has(loc) ? ' [EXCLUDED]' : ''}: scheduledOuts=${scheduledOuts}, activeReservations=${activeReservations}, autobill=${autobillCount}/${occTenants} (${occTenants ? (autobillCount / occTenants * 100).toFixed(1) : '0.0'}%)\n`);
  } catch (e) {
    console.error(`  ${loc}: FAILED — ${e.message}`);
  }
}

console.log(`\n--- Scheduled Reservations vs Scheduled Move-outs ---`);
console.log(`All 29 sites:                          Move-outs ${totalScheduledOuts}, Reservations ${totalActiveRes}`);
console.log(`26 sites (Bedford/Paulton/Exeter excl): Move-outs ${exclScheduledOuts}, Reservations ${exclActiveRes}`);
console.log(`Compare the 26-site row directly to legacy's own widget (Move-outs 222, Reservations 423).`);

console.log(`\n--- Autobill Conversion ---`);
console.log(`All 29 sites:                          ${totalAutobill}/${totalOccTenants} = ${(totalAutobill / totalOccTenants * 100).toFixed(1)}%`);
console.log(`26 sites (Bedford/Paulton/Exeter excl): ${exclAutobill}/${exclOccTenants} = ${(exclAutobill / exclOccTenants * 100).toFixed(1)}%`);
console.log(`Compare the 26-site row directly to legacy's own widget (75%).`);
process.exit(0);
