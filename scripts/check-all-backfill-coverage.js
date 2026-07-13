// Answers two questions at once: (1) is rent_roll's backfill (task #59) actually done, and (2) what
// concrete scope is on the table for task #89 ("decide on stale historical data re-pull scope") --
// backfill-rentroll-gaps.js's own header comment names 5 OTHER reports also found short of
// occupancy's full history: scheduled_outs, marketing, rate_changes, true_revenue, reservations.
// This checks every one of them against occupancy's month coverage, same "gap" definition
// backfill-rentroll-gaps.js uses (report entirely missing for a month that occupancy has).
//
// PAGINATION: properly ordered this time -- .order('id').range() on every page, not just
// .range() alone. backfill-rentroll-gaps.js's own fetchAllMonths() helper (and the ORIGINAL
// version of check-leadfunnel-coverage.js) paginated with .range() but no .order('id') first --
// Postgres/PostgREST doesn't guarantee stable ordering across separate paginated requests without
// an explicit ORDER BY, which is the exact bug already fixed once in lib/buildPayload.js's
// fetchAllRaw() (6 Jul 2026) and again in check-leadfunnel-coverage.js (10 Jul 2026, this
// session) -- both times it produced a stable-looking but wrong "missing" count. Fixing it here
// too before trusting any of these numbers.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-all-backfill-coverage.js
import { admin } from '../lib/supabaseAdmin.js';

const REPORTS_TO_CHECK = ['rent_roll', 'scheduled_outs', 'marketing', 'rate_changes', 'true_revenue', 'reservations'];

async function fetchAllMonths(rep) {
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from('raw_report')
      .select('site_code,month')
      .eq('report', rep)
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${rep}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

const occRows = await fetchAllMonths('occupancy');
const occCombos = new Set(occRows.map((r) => `${r.site_code}|${r.month}`));
const occMonths = new Set([...occCombos].map((c) => c.split('|')[1]));
console.log(`occupancy (reference): ${occRows.length} rows, ${occMonths.size} distinct months, ${occCombos.size} site/month combos.\n`);

for (const rep of REPORTS_TO_CHECK) {
  const rows = await fetchAllMonths(rep);
  const combos = new Set(rows.map((r) => `${r.site_code}|${r.month}`));
  const missing = [...occCombos].filter((c) => !combos.has(c));
  const missingMonths = new Set(missing.map((c) => c.split('|')[1]));
  console.log(`${rep.padEnd(14)} rows=${String(rows.length).padStart(5)}  missing combos=${String(missing.length).padStart(4)}  missing months=${missingMonths.size ? [...missingMonths].sort().join(', ') : 'none'}`);
}
process.exit(0);
