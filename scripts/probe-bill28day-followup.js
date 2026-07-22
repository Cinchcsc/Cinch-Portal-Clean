// FOLLOW-UP PROBE (22 Jul 2026), task #308. probe-exhaustive-billing-search.js found the real lead:
// UnitPriceList (ReportingWs, never integrated into this project before) has literal Bill28DayRate/
// Bill28DayTotal columns sitting next to StandardRate/WeeklyRate -- SiteLink's own "Bill28Day" naming,
// almost exactly R6's term. But it's a RATE CARD (one row per unit type/size), not per-tenant, and
// the one sample row we saw had Bill28DayRate=0 -- L001/Bicester may just not have this plan active
// for that unit type, not proof the mechanism is fake.
//
// Two follow-ups in one pass:
//  1. Dump ALL of L001's UnitPriceList rows (not just the first) -- is Bill28DayRate ever non-zero
//     ANYWHERE at this site? If every row is 0, Bicester genuinely has no 4-weekly plan active, which
//     would explain why 0 tenants were ever flagged there (consistent with, not contradicting, R6).
//  2. Dump the 12 RentRoll rows (of 318 occupied) where dcSchedRent was non-zero -- previously
//     dismissed as "probably a pending rate-change field", but worth a real look now: does dcSchedRent
//     relate to dcRent the way Bill28DayRate relates to StandardRate on the rate card?
//  3. Repeat both checks against L009 (Newbury) -- task #196 found its plain Rate running 8-29% HIGH
//     with no explanation ever confirmed. If L009 has real Bill28Day activity where Bicester doesn't,
//     that's the same missing adjustment explaining two open mysteries at once.
//
// Run:  node --env-file=.env scripts/probe-bill28day-followup.js
import { callReport } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? '').trim());

async function checkSite(site) {
  console.log(`\n\n########## ${site} ##########`);

  console.log(`\n=== UnitPriceList (${site}) ===`);
  const { rows: uplRows } = await callReport('UnitPriceList', site, start, now);
  console.log(`${uplRows.length} rows.`);
  const withBill28 = uplRows.filter((r) => num(r.Bill28DayRate) !== 0 || num(r.Bill28DayTotal) !== 0);
  console.log(`${withBill28.length}/${uplRows.length} row(s) have a non-zero Bill28DayRate/Total.`);
  for (const r of uplRows) {
    console.log(`  Type=${r.Type} Size=${r.UnitSize || ''} Area=${r.Area} iUnitTypeID=${r.iUnitTypeID}  StandardRate=${r.StandardRate}  WeeklyRate=${r.WeeklyRate}  Bill28DayRate=${r.Bill28DayRate}  Bill28DayTotal=${r.Bill28DayTotal}`);
  }

  console.log(`\n=== RentRoll dcSchedRent-nonzero rows (${site}) ===`);
  const { rows: rrRows } = await callReport('RentRoll', site, start, now);
  const occ = rrRows.filter((r) => yes(r.bRented));
  const schedRows = occ.filter((r) => num(r.dcSchedRent) !== 0);
  console.log(`${schedRows.length}/${occ.length} occupied row(s) have non-zero dcSchedRent.`);
  for (const r of schedRows) {
    console.log(`  ${r.sUnitName} (UnitTypeID ${r.UnitTypeID}, ${r.sTypeName}): dcRent=${r.dcRent} dcStdRate=${r.dcStdRate} dcSchedRent=${r.dcSchedRent} dcSchedRateWeekly=${r.dcSchedRateWeekly} dcSchedRateMonthly=${r.dcSchedRateMonthly} ratio dcRent/dcSchedRent=${num(r.dcSchedRent) ? (num(r.dcRent) / num(r.dcSchedRent)).toFixed(3) : 'n/a'}`);
  }

  // Cross-reference: for schedRows, does dcRent match this unit type's Bill28DayRate rather than
  // its StandardRate? Would be strong, direct confirmation of the mechanism.
  if (schedRows.length) {
    console.log(`\n--- Cross-reference vs UnitPriceList for the ${site} rows above ---`);
    for (const r of schedRows) {
      const card = uplRows.find((u) => String(u.iUnitTypeID) === String(r.UnitTypeID));
      if (!card) { console.log(`  ${r.sUnitName}: no matching UnitPriceList row for UnitTypeID ${r.UnitTypeID}`); continue; }
      console.log(`  ${r.sUnitName}: dcRent=${r.dcRent} vs this type's StandardRate=${card.StandardRate} / Bill28DayRate=${card.Bill28DayRate} / WeeklyRate=${card.WeeklyRate}`);
    }
  }
}

await checkSite('L001');
await checkSite('L009');
process.exit(0);
