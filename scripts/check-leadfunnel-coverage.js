// Verify the expanded lead_funnel repull ("repull all months, 96" -> repull-report-all-months.js
// lead_funnel) actually completed across every stored month for every site -- read-only, no
// SiteLink calls. Uses occupancy as the reference report (every active site/month has one) and
// checks whether a matching lead_funnel row also exists. Missing combos = gaps the repull didn't
// cover (still running, errored partway, or never started). Also prints pulled_at range so we can
// see how recent the repull actually was.
//
// FIXED 10 Jul 2026: the original version of this script did a plain .select(...).eq('report', X)
// with no pagination. Supabase/PostgREST caps an unpaginated select at 1000 rows -- with 29 sites x
// 71+ months, both occupancy and lead_funnel now have 2000+ rows each, so BOTH queries were being
// silently truncated to an arbitrary first-1000-rows slice. Comparing two arbitrary partial slices
// produced a stable-looking but meaningless "714 missing" result that persisted across repeated
// runs (including after the full repull genuinely completed with 0 failures). This is the exact
// same bug class already found and fixed once before in lib/buildPayload.js's fetchAllRaw() (see
// its comment, task #92 / 6 Jul 2026 fix) -- paging with .order('id').range() so long histories
// don't silently truncate.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-leadfunnel-coverage.js
import { admin } from '../lib/supabaseAdmin.js';
import { listStoredMonths } from '../lib/buildPayload.js';

async function fetchAllRows(report, columns) {
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from('raw_report')
      .select(columns)
      .eq('report', report)
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

const months = await listStoredMonths();
console.log(`Stored months (${months.length}): ${months.join(', ')}\n`);

const occRows = await fetchAllRows('occupancy', 'site_code,month');
const activeCombos = new Set(occRows.map((r) => `${r.site_code}|${r.month}`));

const lfRows = await fetchAllRows('lead_funnel', 'site_code,month,pulled_at');
const lfMap = new Map(lfRows.map((r) => [`${r.site_code}|${r.month}`, r.pulled_at]));

const missing = [];
let mostRecent = null, oldest = null;
for (const combo of activeCombos) {
  if (!lfMap.has(combo)) { missing.push(combo); continue; }
  const pulledAt = lfMap.get(combo);
  if (!mostRecent || pulledAt > mostRecent) mostRecent = pulledAt;
  if (!oldest || pulledAt < oldest) oldest = pulledAt;
}

console.log(`occupancy rows fetched: ${occRows.length}`);
console.log(`lead_funnel rows fetched: ${lfRows.length}`);
console.log(`Active site/month combos (per occupancy): ${activeCombos.size}`);
console.log(`lead_funnel rows present: ${lfMap.size}`);
console.log(`Missing: ${missing.length}`);
if (missing.length) {
  console.log('\nMissing site/month combos:');
  for (const m of missing.sort()) console.log(`  ${m}`);
} else {
  console.log('\nFull coverage -- every active site/month has a lead_funnel row.');
}
console.log(`\nOldest lead_funnel pulled_at: ${oldest}`);
console.log(`Most recent lead_funnel pulled_at: ${mostRecent}`);
process.exit(0);
