// PROBE (22 Jul 2026), task #308/#403 follow-up. The catalog re-scan just found a much stronger
// Credits candidate than GeneralJournalEntries: CorpReportID 460636, "XML_EURO\Adjustments for
// MoveOuts and Waived Charges In Date Range" -- 112 rows for July MTD (vs GeneralJournalEntries'
// 11-row aggregate "Credits Issued" bucket, which was ~7x too small). Unlike GeneralJournalEntries,
// this is PER-CHARGE, PER-TENANT data: Waived date, LedgerID/TenantID/Unit, ChargeDesc/AccountName
// (Rent/StoreProtect/Fee/etc.), Charge/Tax/Total amounts, and a free-text `ScreditNote` reason field
// (e.g. "Late fee removed not customers fault", "Has own padlock") -- exactly the shape a per-unit
// "Credits" figure feeding Real Rate would need, and rich enough to filter to Rent-only if that's what
// R6's formula actually wants.
//
// Also checks CorpReportID 460635 ("Adjustments for Refunds Due In Date Range", 29 rows) as a second
// candidate -- refunds (money given back after being charged/paid) are a related but distinct concept
// from waived charges (never collected, or forgiven), and R6's "Credits" might mean one, the other, or
// both combined.
//
// Sums BOTH pre-tax (Charge/RefundAmt) and post-tax (Total/RefundTotal) totals, split Rent-only
// (ChargeDesc/Category containing "rent", case-insensitive, matching this codebase's established
// charge-category filter convention) vs every category, so nothing is assumed or hidden. Prints
// against the already-quantified ~£12-18k/month Bicester Real Rate gap for direct comparison.
//
// Run:  node --env-file=.env scripts/probe-waived-charges-credits.js [siteCode]
import { callCustomReport } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-waived-charges-credits.js <siteCode>'); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const isRent = (v) => /rent/i.test(String(v ?? ''));

console.log(`Site: ${site}   Date range: ${start.toISOString()} to ${now.toISOString()}\n`);

async function dumpAndSum(reportId, label, { descField, amountField, taxField, totalField, ledgerField }) {
  console.log(`\n${'='.repeat(70)}\n${label} (ReportID ${reportId})\n${'='.repeat(70)}`);
  const { rows } = await callCustomReport(reportId, site, start, now);
  console.log(`${rows.length} row(s) returned.`);
  if (!rows.length) return;

  const allKeys = new Set();
  for (const r of rows) for (const k of Object.keys(r)) allKeys.add(k);
  console.log(`Columns (union across all rows): ${[...allKeys].join(', ')}`);

  const byDesc = {};
  for (const r of rows) {
    const d = String(r[descField] ?? '(blank)');
    (byDesc[d] ??= []).push(r);
  }
  console.log(`\n${descField} distribution:`, JSON.stringify(Object.fromEntries(Object.entries(byDesc).map(([k, v]) => [k, v.length]))));

  const sumAll = { amount: 0, tax: 0, total: 0 };
  const sumRent = { amount: 0, tax: 0, total: 0 };
  const ledgerIds = new Set();
  for (const r of rows) {
    const amt = num(r[amountField]), tax = num(r[taxField]), tot = num(r[totalField]);
    sumAll.amount += amt; sumAll.tax += tax; sumAll.total += tot;
    if (isRent(r[descField])) { sumRent.amount += amt; sumRent.tax += tax; sumRent.total += tot; }
    if (ledgerField && r[ledgerField] != null) ledgerIds.add(String(r[ledgerField]));
  }
  console.log(`\nAll categories:  Σ${amountField}=£${R2(sumAll.amount)}   Σ${taxField}=£${R2(sumAll.tax)}   Σ${totalField}=£${R2(sumAll.total)}`);
  console.log(`Rent-only:       Σ${amountField}=£${R2(sumRent.amount)}   Σ${taxField}=£${R2(sumRent.tax)}   Σ${totalField}=£${R2(sumRent.total)}`);
  if (ledgerField) console.log(`Distinct ${ledgerField}s touched: ${ledgerIds.size} (of ~318 occupied tenants at L001 -- gauges how widespread this is)`);

  // Any free-text note/reason column (e.g. ScreditNote) -- show a sample so the real reasons behind
  // these adjustments can be judged, not assumed.
  const noteCol = [...allKeys].find((k) => /note/i.test(k));
  if (noteCol) {
    const withNotes = rows.filter((r) => r[noteCol]);
    console.log(`\n${withNotes.length} of ${rows.length} rows have a non-blank ${noteCol}. Sample reasons:`);
    withNotes.slice(0, 15).forEach((r) => console.log(`  - "${r[noteCol]}"  (${r[descField]}, £${r[amountField]})`));
  }
  return { sumAll, sumRent };
}

const waived = await dumpAndSum(460636, 'Adjustments for MoveOuts and Waived Charges In Date Range', {
  descField: 'ChargeDesc', amountField: 'Charge', taxField: 'Tax', totalField: 'Total', ledgerField: 'LedgerID',
});

const refunds = await dumpAndSum(460635, 'Adjustments for Refunds Due In Date Range', {
  descField: 'Category', amountField: 'RefundAmt', taxField: 'RefundTax', totalField: 'RefundTotal', ledgerField: 'LedgerID',
});

console.log(`\n${'='.repeat(70)}\nCombined vs the already-quantified Bicester gap\n${'='.repeat(70)}`);
if (waived && refunds) {
  const combinedRentPreTax = R2(waived.sumRent.amount + refunds.sumRent.amount);
  const combinedAllPreTax = R2(waived.sumAll.amount + refunds.sumAll.amount);
  console.log(`Waived charges + Refunds, Rent-only, pre-tax:  £${combinedRentPreTax}`);
  console.log(`Waived charges + Refunds, ALL categories, pre-tax:  £${combinedAllPreTax}`);
}
console.log(`\nPartial Real Rate (adjusted rent minus discounts, no Credits): £28.59 (SS) / £27.39 (Total) per sqft/yr`);
console.log(`Legacy true Real Rate:                                          £19.50 (SS) / £18.66 (Total) per sqft/yr`);
console.log(`Implied missing Credits gap: roughly £12-18k/month at this one site -- compare the sums above`);
console.log(`against that magnitude (this pull covers ${start.toISOString().slice(0, 10)} to ${now.toISOString().slice(0, 10)}, i.e. MTD, not a full month -- scale accordingly).`);
process.exit(0);
