// Michael's boss sent MerchandiseActivity_20260701_20260709.xlsx (L001, per-transaction inventory
// log) alongside MerchandiseSummary (the report we already pull). MerchandiseActivity has columns
// MerchandiseSummary doesn't: sReason (Sold/Shipment/Other/...), sTenantName, sUnitName. In the
// sample file, the ONE "Sold" row has sTenantName = "Walk-In POS" (SiteLink's placeholder for a
// till sale with no specific tenant/unit) — the OTHER two rows are "Other" (a -23 adjustment,
// comment "Online move ins") and "Shipment" (receiving stock, +72), neither a sale at all.
//
// This is a real lead on the ~11x Merchandise-Income-per-New-Customer gap: every numerator we've
// tried so far (MerchandiseSummary.dcChargeTotal, FinancialSummary's POS category, True Revenue's
// AccountCode 201) is a straight revenue total with NO tenant attribution — it counts walk-in retail
// sales (padlocks/boxes to anyone, not tied to a move-in) the same as anything else. If legacy's
// "per new customer" figure only counts merchandise attributable to an actual tenant (excluding
// "Walk-In POS"), that would shrink the numerator a lot, in the right direction to close the gap.
//
// This script pulls MerchandiseActivity live (same SOAP mechanism as every other report — first run
// will reveal the real method name from the WSDL if "MerchandiseActivity" isn't exactly right) and
// breaks the £ total into Walk-In POS vs tenant-linked vs blank. NEVER prints sTenantName itself
// (PII) — only which bucket it falls into.
//
// CORRECTED after the first live run: dcOldPrice/dcNewPrice on a "Sold" row are BLANK — those two
// columns only carry a value on "Other"-reason PRICE-CHANGE events (confirmed live: L001's one real
// "Sold" row priced at £0 with that approach, even though MerchandiseSummary shows £120 charged for
// the same site/window). MerchandiseActivity is a pure QUANTITY log; it carries no £ amount for a
// sale at all. Fix: pull MerchandiseSummary for the same site/window first, build a per-SKU
// EFFECTIVE rate (dcChargeTotal / abs(dcSold) — inc. tax, matches what "sales" already means
// elsewhere in this codebase) keyed by sDesc, then price each "Sold" Activity row via that rate x
// dcQty. Note dcSold in MerchandiseSummary is a SIGNED inventory delta (negative = sold, confirmed
// live: Extra Large Box dcSold=-20, dcChargeTotal=£120 -> £6/unit inc. tax) — abs() it.
// Run: cd cinch-portal-clean && node --env-file=.env scripts/probe-merch-activity.js [siteCode] [YYYY-MM]
import { callReport } from '../lib/sitelink.js';
import { REPORTS } from '../lib/reportMap.js';

const siteCode = process.argv[2] || 'L001';
const monthArg = process.argv[3]; // optional YYYY-MM; defaults to current month-to-date
const now = new Date();
let start, end;
if (monthArg) {
  const [y, m] = monthArg.split('-').map(Number);
  start = new Date(y, m - 1, 1);
  const fullMonthEnd = new Date(y, m, 0);
  const isCurrentMonth = y === now.getFullYear() && m === now.getMonth() + 1;
  end = isCurrentMonth && fullMonthEnd > now ? now : fullMonthEnd;
} else {
  start = new Date(now.getFullYear(), now.getMonth(), 1);
  end = now;
}
const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
console.log(`=== MerchandiseActivity probe, ${siteCode}, ${fmt(start)} to ${fmt(end)} ===\n`);

const num = (v) => Number(v) || 0;

// Per-SKU effective rate (inc. tax, matches "sales" everywhere else in this codebase) from
// MerchandiseSummary — MerchandiseActivity's "Sold" rows carry no £ amount of their own.
const { rows: msRows } = await callReport(REPORTS.merchandise.method, siteCode, start, end);
const officialSales = msRows.reduce((a, r) => a + num(r.dcChargeTotal), 0);
const rateBySku = {};
for (const r of msRows) {
  const units = Math.abs(num(r.dcSold));
  if (units > 0) rateBySku[r.sDesc] = num(r.dcChargeTotal) / units;
}

const { rows } = await callReport('MerchandiseActivity', siteCode, start, end);
console.log(`${rows.length} row(s) returned.`);
if (!rows.length) { console.log('No data for this window.'); process.exit(0); }
console.log(`Columns: ${Object.keys(rows[0]).join(', ')}\n`);

const byReason = {};
for (const r of rows) { const rk = r.sReason || '(blank)'; byReason[rk] = (byReason[rk] || 0) + 1; }
console.log('Row counts by sReason:');
for (const [k, v] of Object.entries(byReason)) console.log(`  ${k.padEnd(16)} ${v}`);

// Only "Sold" rows are actual retail sales — everything else (Shipment/Other/Transfer/etc.) is
// inventory movement, not revenue.
const sold = rows.filter((r) => /^sold$/i.test(r.sReason || ''));
console.log(`\n${sold.length} "Sold" row(s). Bucketing by tenant attribution (counts/£ only, never printing the actual name):`);

const bucket = (r) => {
  const t = (r.sTenantName || '').trim();
  if (!t) return 'blank (no tenant recorded)';
  if (/^walk-?in pos$/i.test(t)) return 'Walk-In POS (till sale, no tenant)';
  return 'named tenant (real customer/unit)';
};
const agg = {};
let noRate = 0;
for (const r of sold) {
  const b = bucket(r);
  const rate = rateBySku[r.sDesc];
  if (rate == null) { noRate++; continue; }
  const amount = rate * num(r.dcQty);
  const o = (agg[b] ??= { count: 0, amount: 0 });
  o.count++; o.amount += amount;
}
let grand = 0;
for (const [b, o] of Object.entries(agg)) {
  console.log(`  ${b.padEnd(38)} ${String(o.count).padStart(3)} txn(s)   ~£${o.amount.toFixed(2)}`);
  grand += o.amount;
}
if (noRate) console.log(`  (${noRate} "Sold" row(s) skipped — SKU not found in MerchandiseSummary for this window)`);
console.log(`\nReconstructed total (per-SKU rate x qty, "Sold" rows only): ~£${grand.toFixed(2)}`);
console.log(`MerchandiseSummary.dcChargeTotal for the same site/window (what "sales" means today): £${officialSales.toFixed(2)}`);
const nonWalkIn = Object.entries(agg).filter(([b]) => !/^Walk-In POS/.test(b)).reduce((a, [, o]) => a + o.amount, 0);
console.log(`Excluding Walk-In POS: ~£${nonWalkIn.toFixed(2)} (${grand ? ((nonWalkIn / grand) * 100).toFixed(1) : '0'}% of the reconstructed total)`);
process.exit(0);
