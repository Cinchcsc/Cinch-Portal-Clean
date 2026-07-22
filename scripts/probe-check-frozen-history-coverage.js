// PROBE (22 Jul 2026), task #308/#403 — probe-realrate-may-april-verify.js found ZERO frozen rent_roll
// for May/April 2026 at all, and June's is confirmed stale (pulled 9 days after month-end). Before
// treating "no second closed-month cross-check is possible" as a hard stop given Friday's cutover
// target, this checks whether OTHER reports (occupancy, discounts, true_revenue) have properly-timed
// frozen data for May/April/June that RentRoll doesn't -- if OccupancyStatistics has its own accurate
// area/occupancy snapshot for a month RentRoll missed, that could still unlock a real cross-check.
//
// Also lists EVERY month this site has ANY frozen rent_roll for for at all (not just Apr/May/Jun), so
// it's clear whether there's some OTHER already-closed month with a properly-timed snapshot that could
// serve as the second data point instead.
//
// Run:  node --env-file=.env scripts/probe-check-frozen-history-coverage.js [siteCode]
import { admin } from '../lib/supabaseAdmin.js';

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-check-frozen-history-coverage.js <siteCode>'); process.exit(1); }

console.log(`=== Every frozen rent_roll this site has, any month, with pull timing ===\n`);
{
  const { data, error } = await admin.from('raw_report').select('month, pulled_at').eq('site_code', site).eq('report', 'rent_roll').order('month', { ascending: true });
  if (error) { console.error('Supabase error:', error.message); }
  else if (!data || !data.length) { console.log('No rent_roll snapshots stored for this site at all.'); }
  else {
    for (const row of data) {
      const monthDate = new Date(row.month);
      const monthEnd = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);
      const pulledAt = new Date(row.pulled_at);
      const daysLate = Math.round((pulledAt - monthEnd) / 86400000);
      const isCurrentMonth = monthDate.getFullYear() === new Date().getFullYear() && monthDate.getMonth() === new Date().getMonth();
      console.log(`  ${row.month.slice(0, 7)}: pulled ${row.pulled_at}  (${isCurrentMonth ? 'still the current/live month' : daysLate <= 2 ? `${daysLate}d after month-end — looks trustworthy` : `${daysLate}d after month-end — STALE`})`);
    }
  }
}

console.log(`\n=== Does OccupancyStatistics have frozen data for April/May/June that rent_roll doesn't? ===\n`);
for (const month of ['2026-04-01', '2026-05-01', '2026-06-01']) {
  const { data, error } = await admin.from('raw_report').select('pulled_at').eq('site_code', site).eq('month', month).eq('report', 'occupancy').limit(1);
  if (error) { console.log(`  ${month.slice(0, 7)}: Supabase error - ${error.message}`); continue; }
  if (!data || !data.length) { console.log(`  ${month.slice(0, 7)}: no frozen occupancy snapshot either.`); continue; }
  const monthDate = new Date(month);
  const monthEnd = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);
  const pulledAt = new Date(data[0].pulled_at);
  const daysLate = Math.round((pulledAt - monthEnd) / 86400000);
  console.log(`  ${month.slice(0, 7)}: pulled ${data[0].pulled_at}  (${daysLate}d after month-end${daysLate <= 2 ? ' — looks trustworthy!' : ' — also stale'})`);
}

console.log(`\n=== Every report type this site has ANY frozen data for, with month coverage ===\n`);
{
  const { data, error } = await admin.from('raw_report').select('report, month').eq('site_code', site).order('report', { ascending: true }).order('month', { ascending: true });
  if (error) { console.error('Supabase error:', error.message); }
  else {
    const byReport = {};
    for (const row of data || []) (byReport[row.report] ??= []).push(row.month.slice(0, 7));
    for (const [report, months] of Object.entries(byReport)) console.log(`  ${report}: ${months.join(', ')}`);
  }
}
process.exit(0);
