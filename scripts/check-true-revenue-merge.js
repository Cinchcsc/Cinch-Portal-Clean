// Michael asked (6 Jul) whether the True Revenue "Merchandise" merge correctly swept up things like
// "Electricity Charge" — worth checking because the merge logic is a CROSS-REPORT match: it takes
// the set of ChargeDesc labels tagged category='POS' in the 'financial' report (FinancialSummary),
// then merges any true_revenue.by_desc row (from a totally different report, CustomReportByReportID
// 781861) whose desc is in that POS set into one "Merchandise" row (see buildPayload.js line ~251-262).
// Cross-report label matching is fragile — FinancialSummary's POS category might use different/
// broader labels than true_revenue's ChargeDesc, so this dumps: (a) the actual POS-tagged descs from
// 'financial', (b) every true_revenue by_desc row, and (c) which of those got merged into Merchandise
// vs kept separate — so we can eyeball whether non-merchandise charges (utilities, fees) are being
// wrongly swept in, or genuine merchandise SKUs are being missed.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-true-revenue-merge.js [YYYY-MM]
import { buildPayloadRange, listStoredMonths } from '../lib/buildPayload.js';
import { admin } from '../lib/supabaseAdmin.js';

const arg = process.argv[2];
const mk = arg || (await listStoredMonths()).slice(-1)[0];
const [y, m] = mk.split('-').map(Number);
const p = await buildPayloadRange(new Date(y, m - 1, 1), new Date(y, m - 1, 1));

console.log(`Month: ${mk}\n`);

// Recompute posDescs the same way buildPayload.js does, per site, then union across sites.
// (fin.categories is exposed per-site as s.revenue.categories — see buildPayload.js recordFor().)
const posDescsAll = new Set();
for (const s of p.sites) {
  for (const c of (s.revenue?.categories || [])) {
    if (c.category === 'POS') posDescsAll.add(c.desc);
  }
}
console.log('POS-tagged ChargeDesc labels from FinancialSummary (financial.categories, category=POS):');
console.log(posDescsAll.size ? [...posDescsAll].sort().join(', ') : '(none found — check field name below)');

console.log('\nFinal merged True Revenue "by desc" rows (post-merge, what the widget shows):');
for (const r of (p.totals.trueRevenueByDesc || [])) console.log(`  ${r.desc}: £${r.truePeriod}`);

// Raw, pre-merge true_revenue by_desc rows for ONE site, so we can see exactly which labels exist
// and cross-check by eye against the posDescsAll set above (which desc strings matched vs didn't).
const oneSite = p.sites[0]?.code;
if (oneSite) {
  const { data } = await admin.from('raw_report').select('data').eq('site_code', oneSite).eq('report', 'true_revenue').eq('month', `${mk}-01`).maybeSingle();
  const byDesc = data?.data?.by_desc || [];
  console.log(`\nRaw true_revenue.by_desc rows for site ${oneSite} BEFORE merge (${byDesc.length} rows):`);
  for (const r of byDesc) console.log(`  ${r.desc}: truePeriod=£${r.truePeriod}  ${posDescsAll.has(r.desc) ? '<- MATCHES POS, merged into Merchandise' : ''}`);
}
process.exit(0);
