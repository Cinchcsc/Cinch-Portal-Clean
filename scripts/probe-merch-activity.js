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
// CORRECTED after the first live run (L001, 1-9 Jul): dcOldPrice/dcNewPrice on a "Sold" row are
// BLANK — those two columns only carry a value on "Other"-reason PRICE-CHANGE events (confirmed
// live: priced at £0 that way, even though MerchandiseSummary shows £120 charged for the same
// site/window). MerchandiseActivity is a pure QUANTITY log; it carries no £ amount for a sale at
// all. Fix: pull MerchandiseSummary for the same site/window first, build a per-SKU EFFECTIVE rate
// (dcChargeTotal / abs(dcSold) — inc. tax, matches what "sales" already means elsewhere in this
// codebase) keyed by sDesc, then price each "Sold" Activity row via that rate x dcQty. Note dcSold
// in MerchandiseSummary is a SIGNED inventory delta (negative = sold, confirmed live: Extra Large
// Box dcSold=-20, dcChargeTotal=£120 -> £6/unit inc. tax) — abs() it. Re-run against L001/1-9 Jul
// confirmed the reconstruction matches exactly (£120.00 = £120.00), and for that one transaction
// 100% of it was Walk-In POS — but that's 1 site/9 days/1 txn, too thin to conclude anything at
// portfolio scale. Hence the ALL mode below.
//
// Run one site:    cd cinch-portal-clean && node --env-file=.env scripts/probe-merch-activity.js L001 2026-06
// Run the portfolio: cd cinch-portal-clean && node --env-file=.env scripts/probe-merch-activity.js ALL 2026-06
// (ALL reads site codes from SITELINK_LOCATIONS in .env; runs sequentially — SiteLink rejects
// parallel logons, same constraint as scripts/backfill.js.)
import { callReport } from '../lib/sitelink.js';
import { REPORTS } from '../lib/reportMap.js';

const siteArg = process.argv[2] || 'L001';
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
const num = (v) => Number(v) || 0;

const bucket = (r) => {
  const t = (r.sTenantName || '').trim();
  if (!t) return 'blank (no tenant recorded)';
  if (/^walk-?in pos$/i.test(t)) return 'Walk-In POS (till sale, no tenant)';
  return 'named tenant (real customer/unit)';
};

// One site's worth of work: returns { agg: {bucket -> {count, amount}}, officialSales, noRate, rowCount }.
async function runSite(siteCode) {
  const { rows: msRows } = await callReport(REPORTS.merchandise.method, siteCode, start, end);
  const officialSales = msRows.reduce((a, r) => a + num(r.dcChargeTotal), 0);
  const rateBySku = {};
  for (const r of msRows) {
    const units = Math.abs(num(r.dcSold));
    if (units > 0) rateBySku[r.sDesc] = num(r.dcChargeTotal) / units;
  }

  const { rows } = await callReport('MerchandiseActivity', siteCode, start, end);
  const sold = rows.filter((r) => /^sold$/i.test(r.sReason || ''));

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
  return { agg, officialSales, noRate, rowCount: rows.length };
}

const printBreakdown = (label, agg, officialSales, noRate) => {
  let grand = 0;
  console.log(`\n${label}`);
  for (const [b, o] of Object.entries(agg)) {
    console.log(`  ${b.padEnd(38)} ${String(o.count).padStart(4)} txn(s)   ~£${o.amount.toFixed(2)}`);
    grand += o.amount;
  }
  if (noRate) console.log(`  (${noRate} "Sold" row(s) skipped — SKU not found in MerchandiseSummary for that window)`);
  console.log(`  Reconstructed total (per-SKU rate x qty): ~£${grand.toFixed(2)}  |  MerchandiseSummary.dcChargeTotal: £${officialSales.toFixed(2)}`);
  const nonWalkIn = Object.entries(agg).filter(([b]) => !/^Walk-In POS/.test(b)).reduce((a, [, o]) => a + o.amount, 0);
  console.log(`  Excluding Walk-In POS: ~£${nonWalkIn.toFixed(2)} (${grand ? ((nonWalkIn / grand) * 100).toFixed(1) : '0'}% of the reconstructed total)`);
};

if (siteArg.toUpperCase() === 'ALL') {
  const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!locations.length) { console.error('SITELINK_LOCATIONS not set'); process.exit(1); }
  console.log(`=== MerchandiseActivity probe, ALL ${locations.length} sites, ${fmt(start)} to ${fmt(end)} ===`);

  const portfolioAgg = {};
  let portfolioOfficial = 0, portfolioNoRate = 0, portfolioRows = 0, sitesWithActivity = 0;
  for (const loc of locations) {
    try {
      const r = await runSite(loc);
      portfolioRows += r.rowCount;
      portfolioOfficial += r.officialSales;
      portfolioNoRate += r.noRate;
      if (Object.keys(r.agg).length) sitesWithActivity++;
      for (const [b, o] of Object.entries(r.agg)) {
        const p = (portfolioAgg[b] ??= { count: 0, amount: 0 });
        p.count += o.count; p.amount += o.amount;
      }
      console.error(`  ${loc}: ${r.rowCount} activity row(s), £${r.officialSales.toFixed(2)} MerchandiseSummary sales`);
    } catch (e) { console.error(`  ${loc}: FAILED — ${e.message}`); }
  }
  console.log(`\n${portfolioRows} total activity row(s) across ${locations.length} sites (${sitesWithActivity} with at least one "Sold" row priced).`);
  printBreakdown('Portfolio-wide breakdown:', portfolioAgg, portfolioOfficial, portfolioNoRate);

  // Close the loop: does excluding Walk-In POS actually move the "per new customer" ratio toward
  // legacy's ~£1.00? Pull the SAME move-ins denominator buildPayload.js uses (ManagementSummary's
  // move_ins field) for the same sites/window and print both ratios side by side.
  let moveIns = 0;
  for (const loc of locations) {
    try {
      const { rows: mgRows } = await callReport(REPORTS.management.method, loc, start, end);
      const parsed = REPORTS.management.parse(mgRows, start, end);
      moveIns += parsed.move_ins || 0;
    } catch (e) { console.error(`  ${loc}: move-ins fetch FAILED — ${e.message}`); }
  }
  const nonWalkInTotal = Object.entries(portfolioAgg).filter(([b]) => !/^Walk-In POS/.test(b)).reduce((a, [, o]) => a + o.amount, 0);
  console.log(`\n${moveIns} total move-ins across ${locations.length} sites for this window.`);
  console.log(`  Merch per new customer, ALL sales (today's numerator):        £${moveIns ? (portfolioOfficial / moveIns).toFixed(2) : 'n/a'}`);
  console.log(`  Merch per new customer, tenant-linked sales only:             £${moveIns ? (nonWalkInTotal / moveIns).toFixed(2) : 'n/a'}`);
} else {
  console.log(`=== MerchandiseActivity probe, ${siteArg}, ${fmt(start)} to ${fmt(end)} ===`);
  const r = await runSite(siteArg);
  console.log(`${r.rowCount} activity row(s) returned.`);
  printBreakdown(`Bucketing "Sold" rows by tenant attribution (counts/£ only, never printing the actual name):`, r.agg, r.officialSales, r.noRate);
}
process.exit(0);
