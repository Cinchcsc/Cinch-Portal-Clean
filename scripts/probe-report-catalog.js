// Michael shared a screenshot of the legacy portal's full report picker (checkbox tree: Consolidated,
// Operations, Financials, Management, Deposits, Revenue Management, Mobile Operations, Insurance) for
// L001 — his boss doesn't know which report/formula produces "Merchandise Income per New Customer",
// so we need to find it ourselves. We've already tested every merchandise numerator we can build
// (MerchandiseSummary, MerchandiseActivity split by Walk-In POS/tenant, Locks Income) against real
// move-in volume across 29 sites and NONE correlate (r = -0.05 to 0.26) — see probe-merch-activity.js.
// That means the answer likely isn't "combine two raw reports ourselves" — it's more likely a SINGLE
// report that already has this (or a closely related) ratio computed, e.g. a portfolio KPI/ranking
// view. Rather than guess report method names one at a time (which just wastes SiteLink calls and
// time), this calls listMethods() ONCE to get the WSDL's actual, authoritative method list, then
// diffs it against every checkbox label from the screenshot to find exact/likely matches — so we
// know definitively which of those ~70 report names are even callable via the API we're already
// using, before trying to pull any of them.
// Run: cd cinch-portal-clean && node --env-file=.env scripts/probe-report-catalog.js
import { listMethods, client, ccwsClient } from '../lib/sitelink.js';

const reportingMethods = await listMethods();
console.log(`=== ReportingWs.asmx: ${reportingMethods.length} methods ===`);
console.log(reportingMethods.sort().join(', '));

let ccwsMethods = [];
try {
  const cc = await ccwsClient();
  ccwsMethods = Object.keys(cc).filter((k) => k.endsWith('Async')).map((k) => k.replace(/Async$/, ''));
  console.log(`\n=== CallCenterWs.asmx: ${ccwsMethods.length} methods ===`);
  console.log(ccwsMethods.sort().join(', '));
} catch (e) { console.log(`\n(CallCenterWs.asmx not reachable: ${e.message})`); }

const allMethods = [...reportingMethods, ...ccwsMethods];

// Every checkbox label from Michael's screenshot (L001 report picker), deduplicated across
// categories (several names appear more than once, e.g. "Financial Summary", "Marketing Summary").
const screenshotLabels = [
  'Consolidated Management', 'Consolidated Lead Funnel', 'Rental Activity', 'Financial Summary', 'Deposits',
  'Site Activity', 'Accounts Receivable', 'Security Deposits', 'Realtime Ranking', 'Promotions Summary',
  'Promotions Activity', 'Marketing Summary', 'Bad Debts', 'Insurance Summary', 'Unpaid Charges',
  'Past Due Balances', 'Merchandise Summary', 'Merchandise Activity', 'Rent Roll', 'Vacant Units',
  'Occupied Units', 'Complimentary Units', 'Move-Ins & Move-Outs', 'Price List', 'Unit Status',
  'Rent Change History', 'Credit Card Roll', 'ACH Billing Roll', 'General Journal Entries', 'Income Analysis',
  'Aged Receivables', 'Credits Issued', 'Receipts', 'Daily Payments', 'Credit Card Payments', 'Prepaid Rent',
  'Prepaid Rent Liabilities', 'Prepaid Insurance', 'Recurring Charges', 'Security Deposit Liabilities',
  'NSF Reversals', 'Payment Activity', 'Refund Summary', 'Refunds Pending', 'Bad Debt Written Off',
  'Management Summary', 'Management History', 'Occupancy Statistics', 'Occupied History', 'Discounts',
  'Discount Summary', 'Exceptions', 'Log On History', 'Hourly Activity', 'Security Settings', 'Manager Activity',
  'Site Inspection', 'Marketing History', 'Postal Code Statistics', 'Advertisement Tracking', 'Marketing Roll',
  'Lead Funnel', 'PC Maintenance', 'TeleTracker Activity', 'Daily Deposit', 'Cash Basis Deposit Details',
  'Accrual Basis Deposit Detail', 'Cash Basis Deposit', 'Rate Management History', 'Tenant Increase Tracking',
  'Unit Demand Tracking', 'Competitor Comparison', 'Dispatch Schedule', 'Insured Roll', 'Insurance Activity',
  'Insurance Statement',
];

// Fuzzy match: strip spaces/punctuation, lowercase, compare — catches "Move-Ins & Move-Outs" vs
// "MoveInsAndMoveOuts", "Rent Change History" vs "TenantRentChangeHistory", etc.
const squash = (s) => s.toLowerCase().replace(/[^a-z]/g, '');
const methodSquashed = allMethods.map((m) => ({ m, sq: squash(m) }));

console.log(`\n=== Matching ${screenshotLabels.length} screenshot labels against ${allMethods.length} real SOAP methods ===`);
const matched = [], unmatched = [];
for (const label of screenshotLabels) {
  const sq = squash(label);
  // exact squash match, or the method name is fully contained in the label's squash (handles
  // "TenantRentChangeHistory" being a superset of "RentChangeHistory" if SiteLink prefixes it).
  const hit = methodSquashed.find((x) => x.sq === sq || sq.includes(x.sq) || x.sq.includes(sq));
  if (hit) matched.push({ label, method: hit.m });
  else unmatched.push(label);
}
console.log(`\nMATCHED (${matched.length}) — callable today via callReport():`);
for (const { label, method } of matched) console.log(`  "${label}"  ->  ${method}`);
console.log(`\nNO MATCH (${unmatched.length}) — not on either WSDL under an obvious name (could be UI-only, or a differently-named/custom report):`);
for (const label of unmatched) console.log(`  "${label}"`);
process.exit(0);
