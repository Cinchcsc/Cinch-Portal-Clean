// Michael's next hypothesis: "Invoiced" merch sales ÷ move-ins — a THIRD distinct number, different
// from both numerators already ruled out (MerchandiseSummary.dcChargeTotal "ALL sales", and
// FinancialSummary's POS-category `Charge` field, aka chargeFromFinancial — both failed the L001/
// L012 exact-£0 test). This one comes from True Revenue (custom report 781861, the "Daily Pro Rate"
// report already driving the Financials page) — its `InvoicedThisPeriod` column, summed across
// whichever ChargeDesc rows are tagged merchandise (same POS-category classification buildPayload.js
// already uses to build the "Merchandise" row on the True Revenue widget, see its trueRevenueByDesc
// merge). "Invoiced" is the raw invoiced amount BEFORE the deferred-revenue/proration adjustments
// that make up "TruePeriod" — a genuinely different number from both prior candidates, from a third
// report, worth testing on its own rather than assumed equivalent to either.
// Also prints TruePeriod for the same merchandise rows as a free bonus comparison, since we're
// already pulling the data.
//
// RESULT: Invoiced£ == FinancialSummary's POS£ EXACTLY at every site, and TruePeriod£ == Invoiced£
// too (no deferral/proration on one-off merchandise sales, so TruePeriod has nothing to differ on).
// True Revenue and FinancialSummary are the SAME underlying figure via two different reports, not
// independent data. Same failure as chargeFromFinancial: nonzero at L001 (£100)/L012 (£165) where
// legacy is exactly £0. This closes off the entire "some report already has the right total" family
// — MerchandiseSummary, FinancialSummary POS, and True Revenue Invoiced/TruePeriod all agree with
// EACH OTHER and all disagree with legacy the same way, because none of them can tell a real
// tenant's purchase apart from an anonymous walk-in sale. MerchandiseActivity's per-transaction
// sTenantName remains the only source in the API that carries that distinction.
// Run: cd cinch-portal-clean && node --env-file=.env scripts/probe-truerevenue-merch-invoiced.js
import { callReport, callCustomReport } from '../lib/sitelink.js';
import { REPORTS } from '../lib/reportMap.js';

const now = new Date();
const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
const str = (v) => (v == null ? '' : String(v));
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? ''));

const KNOWN = {
  L001: { name: 'Bicester', legacy: 0 },
  L012: { name: 'Gillingham', legacy: 0 },
  L029: { name: 'Abingdon', legacy: 41.20 },
  L006: { name: 'Huntingdon', legacy: 0.60 },
  L010: { name: 'Mitcham', legacy: 1.46 },
};

async function runSite(siteCode) {
  const { rows: finRows } = await callReport('FinancialSummary', siteCode, monthStart, now);
  const posDescs = new Set();
  for (const r of finRows) {
    if (str(r.sChgCategory) === 'POS') posDescs.add(str(r.sChgDesc));
  }

  const { rows: trRows } = await callCustomReport(REPORTS.true_revenue.customReportId, siteCode, monthStart, now);
  const trData = REPORTS.true_revenue.parse(trRows, monthStart, now);
  let invoiced = 0, truePeriod = 0;
  for (const row of trData.by_desc) {
    if (posDescs.has(row.desc)) { invoiced += row.invoiced; truePeriod += row.truePeriod; }
  }

  const { rows: mgRows } = await callReport('MoveInsAndMoveOuts', siteCode, monthStart, now);
  const moveIns = mgRows.filter((r) => yes(r.MoveIn)).length;

  return { invoiced, truePeriod, moveIns };
}

console.log(`=== True Revenue "Invoiced" merchandise probe, ${monthStart.toISOString().slice(0, 10)} to ${now.toISOString().slice(0, 10)} ===\n`);
console.log(`${'Site'.padEnd(8)}${'Name'.padEnd(14)}${'MoveIns'.padStart(8)}${'Invoiced£'.padStart(11)}${'InvRatio£'.padStart(11)}${'TruePd£'.padStart(9)}${'TPRatio£'.padStart(10)}  Legacy`);
for (const [code, info] of Object.entries(KNOWN)) {
  try {
    const r = await runSite(code);
    const invRatio = r.moveIns ? r.invoiced / r.moveIns : (r.invoiced ? Infinity : 0);
    const tpRatio = r.moveIns ? r.truePeriod / r.moveIns : (r.truePeriod ? Infinity : 0);
    const fmt = (n) => (n === Infinity ? '£inf' : `£${n.toFixed(2)}`);
    console.log(`${code.padEnd(8)}${info.name.padEnd(14)}${String(r.moveIns).padStart(8)}${fmt(r.invoiced).padStart(11)}${fmt(invRatio).padStart(11)}${fmt(r.truePeriod).padStart(9)}${fmt(tpRatio).padStart(10)}  £${info.legacy}`);
  } catch (e) {
    console.error(`${code}: FAILED — ${e.message}`);
  }
}
console.log('\nCompare InvRatio£ (and TPRatio£, a free bonus check) against the Legacy column.');
process.exit(0);
