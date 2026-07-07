// The KPI Widget Reference doc (Cinch Portal - KPI Widget Reference (Customer).pdf) says Merchandise
// Revenue, Misc Revenue, Credits Issued, Rental Discounts, Debtor Levels, and Past Due Balances all
// come from ManagementSummary's "Receipts" and "Delinquency" sections — but lib/reportMap.js's
// `management` parser currently only extracts a handful of sDesc rows (Move In/Out, Transfers, Leads)
// via regex matching, and has never looked at what else is actually in the raw response. This dumps
// EVERY sDesc row and its iDCount/iMCount/iYCount values for one site, so we can see the full
// Receipts/Delinquency section and compare against what our merchandise/debtor pipeline currently
// uses (FinancialSummary POS category, PastDueBalances report).
// PII-SAFE: ManagementSummary is a portfolio/site-level summary report with no tenant-level data.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-managementsummary-full.js [siteCode]
import { callReport } from '../lib/sitelink.js';

const loc = (process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',')[0] || '').trim();
if (!loc) { console.error('No site code given and SITELINK_LOCATIONS not set'); process.exit(1); }

const now = new Date();
const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const prevEnd = new Date(now.getFullYear(), now.getMonth(), 0);

const { rows } = await callReport('ManagementSummary', loc, prevMonth, prevEnd);
console.log(`Site ${loc}, period ${prevMonth.toISOString().slice(0,10)}..${prevEnd.toISOString().slice(0,10)}: ${rows.length} rows\n`);
console.log('sDesc'.padEnd(40), 'iDCount'.padStart(10), 'iMCount'.padStart(10), 'iYCount'.padStart(10));
for (const r of rows) {
  console.log(String(r.sDesc || '').padEnd(40), String(r.iDCount ?? '').padStart(10), String(r.iMCount ?? '').padStart(10), String(r.iYCount ?? '').padStart(10));
}
console.log('\nAll column names on a row:', rows.length ? Object.keys(rows[0]).filter((c) => !/^(diffgr|msdata)/i.test(c)).join(', ') : '(no rows)');
process.exit(0);
