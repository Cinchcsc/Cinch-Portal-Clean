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
// breaks the £ total (dcQty x dcNewPrice, "Sold" rows only) into Walk-In POS vs tenant-linked vs
// blank. NEVER prints sTenantName itself (PII) — only which bucket it falls into.
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
for (const r of sold) {
  const b = bucket(r);
  const price = num(r.dcNewPrice) || num(r.dcOldPrice);
  const amount = price * num(r.dcQty);
  const o = (agg[b] ??= { count: 0, amount: 0 });
  o.count++; o.amount += amount;
}
let grand = 0;
for (const [b, o] of Object.entries(agg)) {
  console.log(`  ${b.padEnd(38)} ${String(o.count).padStart(3)} txn(s)   ~£${o.amount.toFixed(2)}`);
  grand += o.amount;
}
console.log(`\nRough total (price x qty, "Sold" rows only): ~£${grand.toFixed(2)}`);
const nonWalkIn = Object.entries(agg).filter(([b]) => !/^Walk-In POS/.test(b)).reduce((a, [, o]) => a + o.amount, 0);
console.log(`Excluding Walk-In POS: ~£${nonWalkIn.toFixed(2)} (${grand ? ((nonWalkIn / grand) * 100).toFixed(1) : '0'}% of the rough total)`);

// Sanity check against the report we already pull for this exact site/window.
try {
  const { rows: msRows } = await callReport(REPORTS.merchandise.method, siteCode, start, end);
  const officialSales = msRows.reduce((a, r) => a + num(r.dcChargeTotal), 0);
  console.log(`\nFor comparison, MerchandiseSummary.dcChargeTotal for the same site/window: £${officialSales.toFixed(2)}`);
} catch (e) { console.log(`\n(Could not fetch MerchandiseSummary for comparison: ${e.message})`); }
process.exit(0);
