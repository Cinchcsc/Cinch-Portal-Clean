// Michael's exact view when he sees £0: "All Stores, 1m July 2026" -- that phrasing ("1m") strongly
// suggests the date-RANGE selector set to a 1-month window, not the plain default view. That routes
// through buildPayloadRange() -> mergeSiteAcrossRange() -> mergeRowsAcrossMonths(), a COMPLETELY
// DIFFERENT code path from buildPayload()/portal_payload (which check-portfolio-truerevenue.js just
// proved is correct, £26,808.61 grand total). Every check so far has only exercised the plain-payload
// path. This calls buildPayloadRange() directly for July 2026 (the exact range a "1 month" selector
// would produce) and checks trueRevenueByDesc/taxAdj there -- the one path not yet tested.
// Run: cd cinch-portal-clean && node --env-file=.env scripts/check-range-truerevenue.js [siteCode]
import { buildPayloadRange } from '../lib/buildPayload.js';

const siteCode = process.argv[2]; // optional -- omit to check the portfolio totals only
const from = new Date(2026, 6, 1); // July 2026
const to = new Date(2026, 6, 1);

const payload = await buildPayloadRange(from, to);
console.log(`=== buildPayloadRange(Jul 2026, Jul 2026) -- ${payload.sites.length} sites, range ${JSON.stringify(payload.range)} ===\n`);

if (siteCode) {
  const site = payload.sites.find((s) => s.code === siteCode);
  if (!site) { console.log(`Site ${siteCode} not found (${payload.sites.length} sites present).`); process.exit(0); }
  const rows = site.trueRevenueByDesc || [];
  console.log(`${siteCode} trueRevenueByDesc (${rows.length} rows):`);
  let sum = 0;
  for (const r of rows) { sum += r.taxAdj || 0; console.log(`  ${(r.desc || '').padEnd(24)} taxInvoiced=£${(r.taxInvoiced ?? 0).toFixed(2)}  netTax=£${(r.netTax ?? 0).toFixed(2)}  taxAdj=£${(r.taxAdj ?? 0).toFixed(2)}`); }
  console.log(`\n${siteCode} taxAdj sum: £${sum.toFixed(2)}`);
}

const totalsRows = payload.totals?.trueRevenueByDesc || [];
console.log(`\npayload.totals.trueRevenueByDesc (${totalsRows.length} rows) -- this is what "All Stores" should show:`);
let grand = 0;
for (const r of totalsRows) { grand += r.taxAdj || 0; console.log(`  ${(r.desc || '').padEnd(24)} taxAdj = £${(r.taxAdj ?? 0).toFixed(2)}`); }
console.log(`\nGrand total (range path): £${grand.toFixed(2)}`);
process.exit(0);
