// Task #230, final verification. probe-merchandise-chargedesc-list.js's full portfolio scan gave
// us the real vocabulary: retail products (boxes, tape, bubblewrap, padlocks, mattress/sofa covers,
// packing supplies) are recorded as their own specific ChargeDesc per SKU -- never a generic
// "Merchandise" label (that only exists as SiteLink's own Table1 category rollup, one level up).
// MERCH_DESCS below is the exact, hardcoded set identified from that scan (excluding ambiguous ones
// like "Business Bundle" [a service package] and "MAILBOX" [likely a unit-type charge, not a
// product, and tiny either way]).
//
// This computes the CANDIDATE fix properly: sum Amount for MERCH_DESCS rows where dMovedIn falls in
// the current month (i.e. billed to a customer who moved in this month), portfolio-wide, divided by
// move-ins. Compare the result to legacy's £1.12 -- if close, this confirms the formula and field
// names are right and it's safe to wire into reportMap.js/buildPayload.js/page.js for real.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/verify-merchandise-new-customer-fix.js
import { callCustomReport, extractRows } from '../lib/sitelink.js';
import { callReport } from '../lib/sitelink.js';
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
const start = new Date(now.getFullYear(), now.getMonth(), 1);

let allMerchTotal = 0, newCustMerchTotal = 0, moveInsTotal = 0;

for (const [loc, name] of Object.entries(NAMES)) {
  try {
    const { raw } = await callCustomReport(781861, loc, start, now);
    const rows = extractRows(raw);
    const merchRows = rows.filter((r) => MERCH_DESCS.has(String(r.ChargeDesc ?? '').trim()));
    const allMerch = merchRows.reduce((a, r) => a + num(r, 'Amount'), 0);
    const newCustMerch = merchRows
      .filter((r) => { const mv = r.dMovedIn; if (isBlankDate(mv)) return false; const d = new Date(mv); return d >= start && d <= now; })
      .reduce((a, r) => a + num(r, 'Amount'), 0);

    const { rows: mioRows } = await callReport('MoveInsAndMoveOuts', loc, start, now);
    const moveIns = mioRows.length;

    allMerchTotal += allMerch; newCustMerchTotal += newCustMerch; moveInsTotal += moveIns;
    process.stderr.write(`  ${loc} ${name}: all-merch £${allMerch.toFixed(2)}, new-cust-merch £${newCustMerch.toFixed(2)}, move-ins ${moveIns}\n`);
  } catch (e) {
    console.error(`  ${loc}: FAILED — ${e.message}`);
  }
}

console.log(`\nPortfolio (${Object.keys(NAMES).length} sites, Bedford/Paulton/Exeter excluded):`);
console.log(`  Move-ins: ${moveInsTotal}`);
console.log(`  All-customer merch revenue (retail SKUs only): £${allMerchTotal.toFixed(2)}`);
console.log(`  New-customer-only merch revenue (dMovedIn this month): £${newCustMerchTotal.toFixed(2)}`);
console.log(`  CANDIDATE: new-customer merch ÷ move-ins = £${(newCustMerchTotal / moveInsTotal).toFixed(2)}  <- compare to legacy's £1.12`);
process.exit(0);
