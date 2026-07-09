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
// sales the same as anything else. NEVER prints sTenantName itself (PII) — only which bucket it
// falls into.
//
// CORRECTED after the first live run (L001, 1-9 Jul): dcOldPrice/dcNewPrice on a "Sold" row are
// BLANK — those two columns only carry a value on "Other"-reason PRICE-CHANGE events. MerchandiseActivity
// carries no £ amount for a sale at all. Fix: pull MerchandiseSummary for the same site/window first,
// build a per-SKU EFFECTIVE rate (dcChargeTotal / abs(dcSold), inc. tax) keyed by sDesc, price each
// "Sold" row via rate x dcQty. Confirmed live (L001 1-9 Jul, and portfolio-wide June): reconstruction
// matches MerchandiseSummary.dcChargeTotal exactly.
//
// FIRST PASS RESULT (portfolio, June 2026): excluding Walk-In POS dropped merch-per-new-customer
// from £9.29 to £2.75 -- real, but legacy shows ~£1.00, so ~2.75x still unexplained.
//
// SECOND PASS (this version) -- Michael's boss: "Find a merchandise sales report, then new customers
// for that period." Taken literally: a sale should only count if the BUYER is one of THIS PERIOD'S
// new movers, not just "any named tenant" (an existing tenant buying a padlock mid-tenancy shouldn't
// count either). MoveInsAndMoveOuts' raw rows already carry TenantID for cross-referencing (used
// elsewhere for Autobill Conversion) but MerchandiseActivity only gives a tenant NAME string, no ID
// and no unit — so this joins by NAME (normalized/trimmed/lowercased). That's inherently approximate
// (formatting differences, etc.) but it's the most direct test of what the boss described. Never
// prints a name — only match/no-match. First run will print the exact MoveInsAndMoveOuts column it
// found the name in (or the full column list if none of the guessed candidates exist), so we can
// correct the guess if needed.
//
// Run one site:      cd cinch-portal-clean && node --env-file=.env scripts/probe-merch-activity.js L001 2026-06
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
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? ''));
// FIXED after the first name-join run (portfolio, June): exact trim+lowercase got ZERO matches out
// of 244 tenant-linked sales, across 29 sites and 1055 move-ins — suspiciously round, given how
// commonly people buy a padlock/box right at move-in. Almost certainly a "Last, First" vs "First
// Last" (or similar word-order/punctuation) mismatch between the two reports, a known SiteLink
// inconsistency class elsewhere in this codebase. Fix: normalize to a SORTED, punctuation-stripped
// token set so word order and commas can't cause a false non-match — "Smith, John" and "John Smith"
// both become "john|smith". Still never surfaces the actual name anywhere.
const norm = (s) => String(s || '').replace(/[.,]/g, ' ').trim().toLowerCase().split(/\s+/).filter(Boolean).sort().join('|');
const hasComma = (s) => /,/.test(String(s || ''));
// SECOND FIX after the token-set version ALSO got 0/244: both sides turned out to be comma-formatted
// equally (100% of movers, all 244 tenant sales), so that wasn't it — token-set equality can still
// miss if one side carries a middle name/initial the other omits. Fall back to SURNAME-only (text
// before the first comma) as a looser, separate signal — still never printed, just membership.
const surnameOf = (s) => { const str = String(s || ''); const i = str.indexOf(','); return (i >= 0 ? str.slice(0, i) : str.split(/\s+/).pop() || '').trim().toLowerCase(); };

// Candidate column names for a tenant's display name on MoveInsAndMoveOuts. CONFIRMED live (9 Jul,
// portfolio run): it's "TenantName" (no "s" prefix, unlike MerchandiseActivity's "sTenantName") —
// listed first; the others stay as fallbacks in case a differently-shaped report ever reuses this.
const NAME_FIELD_CANDIDATES = ['TenantName', 'sTenantName', 'sName', 'sCustomerName', 'sFullName'];
let nameFieldUsed = null, nameFieldWarned = false;

// New movers (this site/window) as a Set of normalized names — built once per site, PII stays local
// to this function (never returned/printed, only membership booleans flow out).
async function newMoverNames(siteCode) {
  const { rows } = await callReport('MoveInsAndMoveOuts', siteCode, start, end);
  const moveIns = rows.filter((r) => yes(r.MoveIn));
  if (!nameFieldUsed && rows.length && !nameFieldWarned) {
    const field = NAME_FIELD_CANDIDATES.find((f) => f in rows[0]);
    if (field) { nameFieldUsed = field; console.error(`  (using MoveInsAndMoveOuts."${field}" as the tenant-name field)`); }
    else {
      nameFieldWarned = true;
      console.error(`  (!) none of ${NAME_FIELD_CANDIDATES.join('/')} found on MoveInsAndMoveOuts — columns are: ${Object.keys(rows[0]).join(', ')}`);
      console.error(`  (!) new-mover matching will be skipped until this is corrected.`);
    }
  }
  const names = new Set(), surnames = new Set();
  let commaCount = 0;
  if (nameFieldUsed) for (const r of moveIns) {
    const raw = r[nameFieldUsed];
    if (hasComma(raw)) commaCount++;
    const n = norm(raw); if (n) names.add(n);
    const sn = surnameOf(raw); if (sn) surnames.add(sn);
  }
  return { names, surnames, moveInCount: moveIns.length, commaCount };
}

const bucket = (r, movers, moverSurnames) => {
  const t = (r.sTenantName || '').trim();
  if (!t) return 'blank (no tenant recorded)';
  if (/^walk-?in pos$/i.test(t)) return 'Walk-In POS (till sale, no tenant)';
  if (movers && movers.has(norm(t))) return 'new mover (full-name match)';
  if (moverSurnames && moverSurnames.has(surnameOf(t))) return 'new mover (surname-only match)';
  return 'existing tenant (no match, full or surname)';
};

// One site's worth of work: returns { agg: {bucket -> {count, amount}}, officialSales, noRate, rowCount, moveIns }.
async function runSite(siteCode) {
  const { rows: msRows } = await callReport(REPORTS.merchandise.method, siteCode, start, end);
  const officialSales = msRows.reduce((a, r) => a + num(r.dcChargeTotal), 0);
  const rateBySku = {};
  for (const r of msRows) {
    const units = Math.abs(num(r.dcSold));
    if (units > 0) rateBySku[r.sDesc] = num(r.dcChargeTotal) / units;
  }

  const { names: movers, surnames: moverSurnames, moveInCount, commaCount: moverCommaCount } = await newMoverNames(siteCode);

  const { rows } = await callReport('MerchandiseActivity', siteCode, start, end);
  const sold = rows.filter((r) => /^sold$/i.test(r.sReason || ''));

  const agg = {};
  let noRate = 0, tenantCommaCount = 0;
  for (const r of sold) {
    const t = (r.sTenantName || '').trim();
    if (t && !/^walk-?in pos$/i.test(t) && hasComma(t)) tenantCommaCount++;
    const b = bucket(r, movers, moverSurnames);
    const rate = rateBySku[r.sDesc];
    if (rate == null) { noRate++; continue; }
    const amount = rate * num(r.dcQty);
    const o = (agg[b] ??= { count: 0, amount: 0 });
    o.count++; o.amount += amount;
  }
  return { agg, officialSales, noRate, rowCount: rows.length, moveIns: moveInCount, moverCommaCount, tenantCommaCount };
}

const printBreakdown = (label, agg, officialSales, noRate) => {
  let grand = 0;
  console.log(`\n${label}`);
  for (const [b, o] of Object.entries(agg)) {
    console.log(`  ${b.padEnd(46)} ${String(o.count).padStart(4)} txn(s)   ~£${o.amount.toFixed(2)}`);
    grand += o.amount;
  }
  if (noRate) console.log(`  (${noRate} "Sold" row(s) skipped — SKU not found in MerchandiseSummary for that window)`);
  console.log(`  Reconstructed total (per-SKU rate x qty): ~£${grand.toFixed(2)}  |  MerchandiseSummary.dcChargeTotal: £${officialSales.toFixed(2)}`);
  return grand;
};

if (siteArg.toUpperCase() === 'ALL') {
  const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!locations.length) { console.error('SITELINK_LOCATIONS not set'); process.exit(1); }
  console.log(`=== MerchandiseActivity probe, ALL ${locations.length} sites, ${fmt(start)} to ${fmt(end)} ===`);

  const portfolioAgg = {};
  let portfolioOfficial = 0, portfolioNoRate = 0, portfolioRows = 0, sitesWithActivity = 0, moveIns = 0, moverCommas = 0, tenantCommas = 0;
  for (const loc of locations) {
    try {
      const r = await runSite(loc);
      portfolioRows += r.rowCount;
      portfolioOfficial += r.officialSales;
      portfolioNoRate += r.noRate;
      moveIns += r.moveIns;
      moverCommas += r.moverCommaCount || 0;
      tenantCommas += r.tenantCommaCount || 0;
      if (Object.keys(r.agg).length) sitesWithActivity++;
      for (const [b, o] of Object.entries(r.agg)) {
        const p = (portfolioAgg[b] ??= { count: 0, amount: 0 });
        p.count += o.count; p.amount += o.amount;
      }
      console.error(`  ${loc}: ${r.rowCount} activity row(s), ${r.moveIns} move-ins, £${r.officialSales.toFixed(2)} MerchandiseSummary sales`);
    } catch (e) { console.error(`  ${loc}: FAILED — ${e.message}`); }
  }
  console.log(`\n${portfolioRows} total activity row(s) across ${locations.length} sites (${sitesWithActivity} with at least one "Sold" row priced).`);
  // PII-safe formatting hint: if these two percentages are wildly different (e.g. movers mostly
  // comma-formatted, tenant sales mostly not, or vice versa), that's evidence of a "Last, First" vs
  // "First Last" mismatch between the two reports WITHOUT ever showing an actual name.
  console.log(`(Formatting check, no names shown: ${moveIns ? ((moverCommas / moveIns) * 100).toFixed(0) : 0}% of move-in names contain a comma; ${tenantCommas} tenant-linked Sold row(s) do too.)`);
  const grand = printBreakdown('Portfolio-wide breakdown:', portfolioAgg, portfolioOfficial, portfolioNoRate);

  const nonWalkInTotal = Object.entries(portfolioAgg).filter(([b]) => !/^Walk-In POS/.test(b)).reduce((a, [, o]) => a + o.amount, 0);
  const fullMatchTotal = (portfolioAgg['new mover (full-name match)'] || { amount: 0 }).amount;
  const surnameMatchTotal = fullMatchTotal + (portfolioAgg['new mover (surname-only match)'] || { amount: 0 }).amount;
  console.log(`\n${moveIns} total move-ins across ${locations.length} sites for this window (from MoveInsAndMoveOuts).`);
  console.log(`  Merch per new customer, ALL sales (today's numerator):              £${moveIns ? (portfolioOfficial / moveIns).toFixed(2) : 'n/a'}`);
  console.log(`  Merch per new customer, excl. Walk-In POS (any tenant):             £${moveIns ? (nonWalkInTotal / moveIns).toFixed(2) : 'n/a'}`);
  console.log(`  Merch per new customer, full-name new-mover match only:             £${moveIns ? (fullMatchTotal / moveIns).toFixed(2) : 'n/a'}${nameFieldUsed ? '' : '  (skipped — no usable name field found, see warning above)'}`);
  console.log(`  Merch per new customer, surname-or-better new-mover match:          £${moveIns ? (surnameMatchTotal / moveIns).toFixed(2) : 'n/a'}${nameFieldUsed ? '' : '  (skipped — no usable name field found, see warning above)'}`);
} else {
  console.log(`=== MerchandiseActivity probe, ${siteArg}, ${fmt(start)} to ${fmt(end)} ===`);
  const r = await runSite(siteArg);
  console.log(`${r.rowCount} activity row(s) returned. ${r.moveIns} move-ins this window.`);
  printBreakdown(`Bucketing "Sold" rows (counts/£ only, never printing the actual name):`, r.agg, r.officialSales, r.noRate);
}
process.exit(0);
