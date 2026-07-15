// Task #230, final verification. probe-merchandise-chargedesc-list.js's full portfolio scan gave
// us the real vocabulary: retail products (boxes, tape, bubblewrap, padlocks, mattress/sofa covers,
// packing supplies) are recorded as their own specific ChargeDesc per SKU -- never a generic
// "Merchandise" label (that only exists as SiteLink's own Table1 category rollup, one level up).
// MERCH_DESCS below is the exact, hardcoded set identified from that scan (excluding ambiguous ones
// like "Business Bundle" [a service package] and "MAILBOX" [likely a unit-type charge, not a
// product, and tiny either way]).
//
// UPDATED 15 Jul 2026 (Michael: "would it help if i got june merchper new cust"): YES -- the only
// data point so far was July, a partial/MTD month, so there was no way to tell a real formula
// mismatch apart from a mid-month timing artifact (e.g. move-ins counted immediately but
// merchandise transactions batched/invoiced with a lag). Added a month argument so this can run
// against a COMPLETE, CLOSED month (June) instead of always defaulting to the live current month.
// Also now prints candidates against BOTH move-ins and total occupied units as denominators, plus
// the FinancialSummary-based merchandise total (the one already confirmed accurate for the
// Merchandise Sales card) alongside the True-Revenue-based one, so all 4 combinations tried so far
// are visible side by side for whichever month you give it.
//
// Run (defaults to current month):
//   cd cinch-portal-clean && node --env-file=.env scripts/verify-merchandise-new-customer-fix.js
// Run (a specific closed month, e.g. June 2026):
//   node --env-file=.env scripts/verify-merchandise-new-customer-fix.js 2026-06
import { callCustomReport, extractRows, callReport } from '../lib/sitelink.js';
import { pullReport } from '../lib/reportMap.js';
import { checkPullLock } from '../lib/pullLock.js';

const lock = await checkPullLock();
if (lock.locked) { console.error('[verify-merchandise-new-customer-fix] ' + lock.message); process.exit(1); }

const NAMES = { L001: 'Bicester', L002: 'Leighton Buzzard', L003: 'Letchworth', L004: 'Chippenham', L005: 'Brighton', L006: 'Huntingdon', L007: 'Newmarket', L008: 'Enfield', L009: 'Newbury', L010: 'Mitcham', L011: 'Sittingbourne', L012: 'Gillingham', L013: 'Brentwood', L014: 'Earlsfield', L015: 'Watford', L016: 'Seaford', L017: 'Southend', L018: 'Woking', L019: 'Sidcup', L020: 'Dunstable', L022: 'Swindon', L023: 'Wisbech', L024: 'Newcastle', L025: 'Shoreham-By-Sea', L028: 'Edmonton', L029: 'Abingdon' };

// Exact vocabulary confirmed live 15 Jul 2026 via probe-merchandise-chargedesc-list.js's full scan.
const MERCH_DESCS = new Set([
  'Combi Padlock', 'Combination Padlock', 'Padlock', 'Key Padlock',
  'Medium Box', 'Large Box', 'Extra Large Box', 'Extra Large Box - Tall box', 'Small Box', 'Archive Box', 'Small Archive Box', 'TV Box', 'Wardrobe Box', 'Mirror Box', 'Removal Box',
  'Tape - Roll', 'Tape - Roll (Brown)', 'Tape Brown', 'Brown Tape', 'Tape', 'Tape Roll', 'Tape Fragile', 'Fragile Tape', 'Tape Gun',
  '25m Large Bubblewrap', '10m Bubblewrap', '10mm Bubblewrap', '5m Bubble Wrap',
  'King Size Mattress Cover', 'Single Mattress Cover',
  'Shrink Wrap', 'Shrink Wrap (Clear)', 'Pallet Wrap', 'Pallet Wrap (Black)',
  'Removal Blanket', 'Sofa Cover', 'Arm Chair Cover', 'Dust Cover',
  'Black Marker Pen', 'Scissors',
  'Loose Fill', 'Foam Corners', 'Packing Paper',
  'Paper Shredding Bag', 'Shredding Bag',
  'LED Light Switch', 'Value Pack',
]);

const num = (row, ...keys) => {
  for (const k of keys) {
    if (row && row[k] != null && row[k] !== '') {
      const n = Number(String(row[k]).replace(/[£,%\s]/g, ''));
      if (!Number.isNaN(n)) return n;
    }
  }
  return 0;
};
const isBlankDate = (v) => v === undefined || v === null || v === '' || v === '0001-01-01T00:00:00';

const now = new Date();
const monthArg = process.argv[2]; // optional YYYY-MM
let start, end, monthLabel;
if (monthArg) {
  const [y, m] = monthArg.split('-').map(Number);
  start = new Date(y, m - 1, 1);
  const fullMonthEnd = new Date(y, m, 0, 23, 59, 59);
  const isCurrentMonth = y === now.getFullYear() && m === now.getMonth() + 1;
  end = isCurrentMonth && fullMonthEnd > now ? now : fullMonthEnd;
  monthLabel = monthArg + (isCurrentMonth ? ' (current, partial)' : ' (closed, complete)');
} else {
  start = new Date(now.getFullYear(), now.getMonth(), 1);
  end = now;
  monthLabel = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')} (current, partial)`;
}

let allMerchTR = 0, newCustMerchTR = 0, allMerchFin = 0, moveInsTotal = 0, occTotal = 0;

for (const [loc, name] of Object.entries(NAMES)) {
  try {
    const { raw } = await callCustomReport(781861, loc, start, end);
    const rows = extractRows(raw);
    const merchRows = rows.filter((r) => MERCH_DESCS.has(String(r.ChargeDesc ?? '').trim()));
    const allMerch = merchRows.reduce((a, r) => a + num(r, 'Amount'), 0);
    const newCustMerch = merchRows
      .filter((r) => { const mv = r.dMovedIn; if (isBlankDate(mv)) return false; const d = new Date(mv); return d >= start && d <= end; })
      .reduce((a, r) => a + num(r, 'Amount'), 0);

    const { rows: mioRows } = await callReport('MoveInsAndMoveOuts', loc, start, end);
    const moveIns = mioRows.length;

    const { data: finData } = await pullReport('financial', loc, start, end);
    const finMerch = (finData.categories || []).filter((c) => c.category === 'POS').reduce((a, c) => a + (c.charge || 0), 0);

    const { data: occData } = await pullReport('occupancy', loc, start, end);
    const occ = occData.occupied_units || 0;

    allMerchTR += allMerch; newCustMerchTR += newCustMerch; allMerchFin += finMerch; moveInsTotal += moveIns; occTotal += occ;
    process.stderr.write(`  ${loc} ${name}: TR-merch £${allMerch.toFixed(2)}, new-cust £${newCustMerch.toFixed(2)}, Fin-merch £${finMerch.toFixed(2)}, move-ins ${moveIns}, occ ${occ}\n`);
  } catch (e) {
    console.error(`  ${loc}: FAILED — ${e.message}`);
  }
}

console.log(`\nMonth: ${monthLabel}`);
console.log(`Portfolio (${Object.keys(NAMES).length} sites, Bedford/Paulton/Exeter excluded):`);
console.log(`  Move-ins: ${moveInsTotal}, Occupied units: ${occTotal}`);
console.log(`  Merchandise total via FinancialSummary POS category (matches Merchandise Sales card): £${allMerchFin.toFixed(2)}`);
console.log(`  Merchandise total via True Revenue retail-SKU rows: £${allMerchTR.toFixed(2)}`);
console.log(`  New-customer-only merch (dMovedIn this month, True Revenue rows): £${newCustMerchTR.toFixed(2)}`);
console.log(`\n  Candidate A — FinancialSummary merch ÷ move-ins:        £${(allMerchFin / moveInsTotal).toFixed(2)}`);
console.log(`  Candidate B — FinancialSummary merch ÷ occupied units:  £${(allMerchFin / occTotal).toFixed(2)}`);
console.log(`  Candidate C — True Revenue merch ÷ move-ins:            £${(allMerchTR / moveInsTotal).toFixed(2)}`);
console.log(`  Candidate D — True Revenue merch ÷ occupied units:      £${(allMerchTR / occTotal).toFixed(2)}`);
console.log(`  Candidate E — new-customer-only merch ÷ move-ins:       £${(newCustMerchTR / moveInsTotal).toFixed(2)}`);
console.log(`\nCompare all 5 to legacy's own "Merchandise Income per New Customer" figure for THIS SAME MONTH (check portal.cinchstorage.co.uk/ancillaries/ with the date range set to this month).`);
process.exit(0);
