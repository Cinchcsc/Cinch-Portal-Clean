// Michael's exact view when he sees £0: "All Stores, 1m July 2026" -- that phrasing ("1m") strongly
// suggests the date-RANGE selector set to a 1-month window, not the plain default view. That routes
// through buildPayloadRange() -> mergeSiteAcrossRange() -> mergeRowsAcrossMonths(), a COMPLETELY
// DIFFERENT code path from buildPayload()/portal_payload (which check-portfolio-truerevenue.js just
// proved is correct, £26,808.61 grand total). First pass hardcoded July-to-July and ALSO came back
// correct (£11,894.76) -- so if the live page still shows £0, either the UI's "1 month" preset resolves
// to a different from/to than a plain calendar month (e.g. a rolling window spanning June+July), or the
// bug is purely in frontend rendering, not any backend calculation. The app/api/portfolio/route.js
// handler logs the EXACT from/to + resulting sites/rate for every range request to the `npm run dev`
// terminal (look for a line starting "[api/portfolio] ... RANGE from=... to=...") -- check that log line
// after loading the £0 view, then pass the real from/to here to test the EXACT range being requested.
// Run: cd cinch-portal-clean && node --env-file=.env scripts/check-range-truerevenue.js [siteCode] [from YYYY-MM] [to YYYY-MM]
import { buildPayloadRange } from '../lib/buildPayload.js';

const siteCode = process.argv[2] || undefined; // optional -- omit to check the portfolio totals only
const fromArg = process.argv[3] || '2026-07';
const toArg = process.argv[4] || fromArg;
const [fy, fm] = fromArg.split('-').map(Number);
const [ty, tm] = toArg.split('-').map(Number);
const from = new Date(fy, fm - 1, 1);
const to = new Date(ty, tm - 1, 1);

const payload = await buildPayloadRange(from, to);
console.log(`=== buildPayloadRange(${fromArg}, ${toArg}) -- ${payload.sites.length} sites, range ${JSON.stringify(payload.range)} ===\n`);

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
