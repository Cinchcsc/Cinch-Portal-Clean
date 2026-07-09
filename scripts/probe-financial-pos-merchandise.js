// Michael's question: True Revenue's "Total Merchandise" row is already on the portal — why not
// just use that ÷ move-ins? Checking buildPayload.js turned up something more authoritative that
// the whole 7-pass MerchandiseActivity investigation never touched: `merchandise.chargeFromFinancial`
// (added 6 Jul 2026, BEFORE this investigation started). Per that comment, legacy's OWN TOOLTIP says
// "Merchandise Sales" comes from "Financial Summary -> total of merchandise charges" — NOT
// MerchandiseSummary (dcChargeTotal, what every pass so far has been calling "ALL sales"/"Locks
// Income"/etc.) at all. FinancialSummary's category is "whatever's coded on the TENANT'S LEDGER",
// confirmed via the category code "POS" (npm run check:marketing-fields2, 6 Jul). This is a
// fundamentally different mechanism than MerchandiseActivity's sTenantName="Walk-In POS" text flag —
// it's about whether a charge posts to a real tenant ledger at all, which could easily explain why
// it behaves differently from every numerator tested in probe-merch-activity.js.
// Tests FinancialSummary's POS-category charge total ÷ move-ins against all 5 known live legacy
// figures: L001=£0, L012=£0, L029(Abingdon)=£41.20, L006(Huntingdon)=£1.06/£0.60 (volatile), L010
// (Mitcham)=£1.46 — all for the Jul 1-9 window.
// Run: cd cinch-portal-clean && node --env-file=.env scripts/probe-financial-pos-merchandise.js
import { callReport } from '../lib/sitelink.js';

const now = new Date();
const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
const num = (v) => Number(v) || 0;
const str = (v) => (v == null ? '' : String(v));
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? ''));

const KNOWN = {
  L001: { name: 'Bicester', legacy: 0 },
  L012: { name: 'Gillingham', legacy: 0 },
  L029: { name: 'Abingdon', legacy: 41.20 },
  L006: { name: 'Huntingdon', legacy: 0.60 }, // corrected — the £1.06 reading was a typo, not a second real observation
  L010: { name: 'Mitcham', legacy: 1.46 },
};

async function runSite(siteCode) {
  const { rows: finRows } = await callReport('FinancialSummary', siteCode, monthStart, now);
  let posCharge = 0;
  const nonPos = {};
  for (const r of finRows) {
    const cat = str(r.sChgCategory);
    const ch = num(r.Charge);
    if (!ch) continue;
    if (cat === 'POS') posCharge += ch;
    else nonPos[cat] = (nonPos[cat] || 0) + ch;
  }

  const { rows: mgRows } = await callReport('MoveInsAndMoveOuts', siteCode, monthStart, now);
  const moveIns = mgRows.filter((r) => yes(r.MoveIn)).length;

  return { posCharge, moveIns, categoryCount: Object.keys(nonPos).length + (posCharge ? 1 : 0) };
}

console.log(`=== FinancialSummary POS-category merchandise probe, ${monthStart.toISOString().slice(0, 10)} to ${now.toISOString().slice(0, 10)} ===\n`);
console.log(`${'Site'.padEnd(8)}${'Name'.padEnd(14)}${'MoveIns'.padStart(8)}${'POS£'.padStart(10)}${'Ratio£'.padStart(10)}${'  Legacy'}`);
for (const [code, info] of Object.entries(KNOWN)) {
  try {
    const r = await runSite(code);
    const ratio = r.moveIns ? r.posCharge / r.moveIns : (r.posCharge ? Infinity : 0);
    const ratioStr = ratio === Infinity ? '£inf' : `£${ratio.toFixed(2)}`;
    console.log(`${code.padEnd(8)}${info.name.padEnd(14)}${String(r.moveIns).padStart(8)}${('£' + r.posCharge.toFixed(2)).padStart(10)}${ratioStr.padStart(10)}  £${info.legacy}`);
  } catch (e) {
    console.error(`${code}: FAILED — ${e.message}`);
  }
}
console.log('\nCompare the Ratio£ column directly against the Legacy column on the right.');
process.exit(0);
