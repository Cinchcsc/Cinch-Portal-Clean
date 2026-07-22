// PROBE (22 Jul 2026), task #308/#403 follow-up #7, off the back of probe-full-custom-report-sweep.js.
// That sweep just covered the 66 not-yet-inspected custom reports and surfaced two genuinely new,
// previously-unseen leads worth a full (not truncated) look:
//
// 1. XML_CSALES\CSales Collections Report (460650) -- a SITE-LEVEL (not per-tenant) summary whose
//    first row's Total_x0020_Sq._x0020_Ft = 24931.9800 -- an EXACT match to the total-area-incl-vacant
//    figure already independently computed from RentRoll for this same site/period
//    (probe-r6-realrate-with-credits-preview.js). Two independent SiteLink surfaces agreeing exactly on
//    a figure is the same cross-validation signal that confirmed the £1,446.86 Concessions/Credits
//    number -- and this report also carries Gross_Potential/Gross_Occupied/Gross_Vacant/Discounts/Net
//    columns, which is exactly the shape of a ready-made Real Rate numerator. Only 9 rows were returned
//    and the printed sample was truncated at 500 chars -- need the full, untruncated dump.
//
// 2. XML_TENANT\Tenancy Valuation (460644) -- 340 rows, 27 columns, never opened before. Its name alone
//    ("Valuation") suggests it might carry a per-tenant market/valuation-rate figure distinct from the
//    contracted Rent, which is conceptually close to what "Real Rate" is trying to represent. Didn't
//    match the credit-pattern regex (valuation reports wouldn't use the word "credit"), so the sweep
//    only would have caught it by name -- worth opening directly rather than ruling out on a keyword
//    miss, the same mistake almost made with Billing Frequency.
//
// Also two cheap secondary checks flagged by the sweep's name-match:
// 3. XML_EURO\Charge Batch Invoices In Date Range (460633) -- per-CHARGE invoice detail (554 rows this
//    period) with a real per-line "Discount" column (e.g. Price 56.68, Discount 3.68, Charge 53.00) --
//    a TRANSACTIONAL discount-at-invoice figure, different in kind from the plan-based "Discounts"
//    report already in the formula. Sum it (all-category and Rent-only) for comparison.
// 4. XML_FINANCIAL\COVID-19 Collections Report (763315) -- per-tenant payment-tender breakdown
//    (Cash/Check/Credit/ACH/CreditCard/Debit/AppliedRefund). "Credit" here reads as a TENDER TYPE (paid
//    via in-house credit), not "Credits Issued" -- but sum Credit + AppliedRefund anyway since it's a
//    new angle (credit-as-payment) not yet checked.
//
// All four are the SAME already-established, safe, read-only CustomReportByReportID mechanism used all
// task. No new SOAP surface.
//
// Run:  node --env-file=.env scripts/probe-cscollections-valuation-deep.js [siteCode]
import { callCustomReport } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-cscollections-valuation-deep.js <siteCode>'); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

console.log(`Site: ${site}   Date range: ${start.toISOString()} to ${now.toISOString()}\n`);

console.log(`${'='.repeat(70)}\n1. CSales Collections Report (460650) -- FULL dump, no truncation\n${'='.repeat(70)}`);
{
  const { rows } = await callCustomReport(460650, site, start, now);
  console.log(`${rows.length} row(s).\n`);
  rows.forEach((r, i) => {
    console.log(`--- Row ${i + 1} ---`);
    for (const [k, v] of Object.entries(r)) console.log(`  ${k}: ${v}`);
    console.log('');
  });
  console.log('Reference: total area (incl. vacant) independently computed from RentRoll for this site/period = 24,931.98 sqft.');
  console.log('Reference: already-confirmed Credits Issued (GJE + ManagementSummary Concessions, exact match) = £1,446.86.');
  console.log('Reference: already-confirmed time-limited Discounts = £2,353.04.');
  console.log('Reference: legacy Real Rate (Total) = £18.66/sqft/yr. Ours without this report\'s data = £25.18 (£6.52 off).');
}

console.log(`\n${'='.repeat(70)}\n2. Tenancy Valuation (460644) -- full column list + samples + numeric sums\n${'='.repeat(70)}`);
{
  const { rows } = await callCustomReport(460644, site, start, now);
  console.log(`${rows.length} row(s).\n`);
  const allKeys = new Set();
  for (const r of rows) for (const k of Object.keys(r)) allKeys.add(k);
  console.log(`Columns (union across all rows): ${[...allKeys].join(', ')}\n`);
  console.log('First 5 rows, full:');
  rows.slice(0, 5).forEach((r, i) => console.log(`  ${i + 1}.`, JSON.stringify(r)));

  const numericCols = [...allKeys].filter((k) => {
    const vals = rows.map((r) => r[k]).filter((v) => v !== undefined && v !== null && v !== '');
    if (!vals.length) return false;
    const numeric = vals.filter((v) => !Number.isNaN(Number(String(v).replace(/[£,%\s]/g, ''))));
    return numeric.length / vals.length > 0.8;
  });
  console.log(`\nΣ per numeric-looking column (all ${rows.length} rows):`);
  for (const k of numericCols) console.log(`  Σ ${k} = £${R2(rows.reduce((a, r) => a + num(r[k]), 0))}`);
}

console.log(`\n${'='.repeat(70)}\n3. Charge Batch Invoices In Date Range (460633) -- per-charge Discount sum\n${'='.repeat(70)}`);
{
  const { rows } = await callCustomReport(460633, site, start, now);
  console.log(`${rows.length} row(s).`);
  const allCat = rows.reduce((a, r) => a + num(r.Discount), 0);
  const rentOnly = rows.filter((r) => /rent/i.test(r.ChargeDesc || '')).reduce((a, r) => a + num(r.Discount), 0);
  console.log(`Σ Discount, all categories = £${R2(allCat)}`);
  console.log(`Σ Discount, ChargeDesc='Rent' only = £${R2(rentOnly)}`);
  const byDesc = {};
  for (const r of rows) { const d = r.ChargeDesc || '(none)'; byDesc[d] = (byDesc[d] || 0) + num(r.Discount); }
  console.log('Σ Discount by ChargeDesc:');
  for (const [d, v] of Object.entries(byDesc)) if (v) console.log(`  ${d}: £${R2(v)}`);
}

console.log(`\n${'='.repeat(70)}\n4. COVID-19 Collections Report (763315) -- Credit/AppliedRefund tender-type sum\n${'='.repeat(70)}`);
{
  const { rows } = await callCustomReport(763315, site, start, now);
  console.log(`${rows.length} row(s).`);
  const creditSum = rows.reduce((a, r) => a + num(r.Credit), 0);
  const refundSum = rows.reduce((a, r) => a + num(r.AppliedRefund), 0);
  console.log(`Σ Credit (tender type) = £${R2(creditSum)}`);
  console.log(`Σ AppliedRefund = £${R2(refundSum)}`);
}
process.exit(0);
