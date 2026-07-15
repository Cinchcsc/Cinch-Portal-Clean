// Task #230, second follow-up. The raw dump just showed Table2 (per-transaction) only had 3
// distinct ChargeDesc values in its first 50 rows for Gillingham (Rent, Late Fee, StoreProtect) --
// no "Merchandise" anywhere, even though Table1 (SiteLink's own per-(UnitType,ChargeDesc)
// aggregate) DOES have a literal "Merchandise" row (confirmed on the live Financials page: "Merchandise
// £4,338..."). Likely explanation: Table1's "Merchandise" is SiteLink's own bucket/category label,
// but Table2's raw per-transaction rows record the actual individual product sold (e.g. "Box -
// Medium", "Padlock", specific SKU names) -- so the earlier /merchandis/i regex never had a chance
// of matching. This scans EVERY row across ALL sites (not just a 50-row sample) and lists every
// distinct ChargeDesc value seen, sorted by frequency, so we can visually spot which labels are
// clearly retail/merchandise products rather than guessing at a regex.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-merchandise-chargedesc-list.js
import { callCustomReport, extractRows } from '../lib/sitelink.js';
import { checkPullLock } from '../lib/pullLock.js';

const lock = await checkPullLock();
if (lock.locked) { console.error('[probe-merchandise-chargedesc-list] ' + lock.message); process.exit(1); }

const NAMES = { L001: 'Bicester', L002: 'Leighton Buzzard', L003: 'Letchworth', L004: 'Chippenham', L005: 'Brighton', L006: 'Huntingdon', L007: 'Newmarket', L008: 'Enfield', L009: 'Newbury', L010: 'Mitcham', L011: 'Sittingbourne', L012: 'Gillingham', L013: 'Brentwood', L014: 'Earlsfield', L015: 'Watford', L016: 'Seaford', L017: 'Southend', L018: 'Woking', L019: 'Sidcup', L020: 'Dunstable', L022: 'Swindon', L023: 'Wisbech', L024: 'Newcastle', L025: 'Shoreham-By-Sea', L028: 'Edmonton', L029: 'Abingdon' };

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);

const chargeDescCounts = {};
const chargeDescAmount = {};
const num = (row, ...keys) => {
  for (const k of keys) {
    if (row && row[k] != null && row[k] !== '') {
      const n = Number(String(row[k]).replace(/[£,%\s]/g, ''));
      if (!Number.isNaN(n)) return n;
    }
  }
  return 0;
};

for (const [loc, name] of Object.entries(NAMES)) {
  try {
    const { raw } = await callCustomReport(781861, loc, start, now);
    const rows = extractRows(raw);
    for (const r of rows) {
      const desc = String(r.ChargeDesc ?? '').trim() || '(blank)';
      chargeDescCounts[desc] = (chargeDescCounts[desc] || 0) + 1;
      chargeDescAmount[desc] = (chargeDescAmount[desc] || 0) + num(r, 'Amount');
    }
    process.stderr.write(`  ${loc} ${name}: ${rows.length} rows scanned\n`);
  } catch (e) {
    console.error(`  ${loc}: FAILED — ${e.message}`);
  }
}

console.log('\n--- Every distinct ChargeDesc value seen in Table2 across the whole portfolio, this month ---');
const sorted = Object.entries(chargeDescCounts).sort((a, b) => b[1] - a[1]);
console.log('ChargeDesc'.padEnd(30) + 'Rows'.padEnd(8) + 'Total Amount');
for (const [desc, count] of sorted) {
  console.log(desc.padEnd(30) + String(count).padEnd(8) + '£' + chargeDescAmount[desc].toFixed(2));
}
console.log('\nLook for anything that is clearly a retail product (boxes, locks, tape, bubble wrap, etc) rather than a service charge (Rent, Late Fee, StoreProtect, Insurance) -- those are the rows that should feed the Merchandise Income per New Customer numerator.');
process.exit(0);
