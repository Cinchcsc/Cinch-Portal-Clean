// PROBE (20 Jul 2026), READ-ONLY — investigating today's Ancillaries spot-check gap: Autobill
// Conversion read 77.3% (ours) vs 73% (legacy), Insurance Conversion read 88% (ours) vs 85% (legacy).
// Both metrics have a documented history (tasks #141/#144/#145/#147/#295/#296) of expected drift —
// Autobill Conversion is a daily-sampled average of an inherently volatile point-in-time RentRoll
// cross-reference (confirmed legacy has the same volatility, see lib/buildPayload.js's
// applyAutobillDailyAverage() comment), and Insurance Conversion has NO shared join key between
// InsuranceRoll and MoveInsAndMoveOuts (confirmed dead end, see app/portal-v2/page.js's insConvPct
// comment) — but neither of those explanations has been checked against TODAY'S actual numbers. This
// pulls the real underlying data so the gap can be judged against real volatility/magnitude instead of
// asserting the known-limitation explanation from memory.
//
// 1) Autobill: every autobill_daily row for July 2026, grouped by sample_date (sum-then-divide
//    portfolio-wide per day, exactly like the rest of this codebase's convention) — shows how many
//    days have been sampled since the #295 fix (16 Jul) and how much the daily figure actually swings.
// 2) Insurance Conversion: per-site move_in_tenant_ids count (move_ins_outs) vs insured_new_customers
//    count (insurance_roll) straight from raw_report's already-parsed `data`, current month, both
//    capped and uncapped portfolio totals, plus which sites have small (noisy) denominators.
//
// Run: cd cinch-portal-clean && node --env-file=.env scripts/probe-autobill-insurance-variance.js
import { admin } from '../lib/supabaseAdmin.js';
import { writeFileSync } from 'fs';

const now = new Date();
const curMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

// --- 1) Autobill daily samples for the current month ---
const autobillRows = [];
{
  let lastId = 0;
  for (;;) {
    const { data, error } = await admin.from('autobill_daily').select('id,site_code,sample_date,autobill_new_count,autobill_new_total,pct')
      .eq('month', curMonthKey).gt('id', lastId).order('id').limit(1000);
    if (error) { console.error('autobill_daily fetch failed:', error.message); break; }
    autobillRows.push(...(data || []));
    if (!data || data.length < 1000) break;
    lastId = data[data.length - 1].id;
  }
}
const byDate = {};
for (const r of autobillRows) {
  (byDate[r.sample_date] ??= { count: 0, total: 0, n: 0 });
  byDate[r.sample_date].count += r.autobill_new_count || 0;
  byDate[r.sample_date].total += r.autobill_new_total || 0;
  byDate[r.sample_date].n += 1;
}
const dailyPortfolioPct = Object.entries(byDate).sort(([a], [b]) => a.localeCompare(b))
  .map(([date, o]) => ({ date, sites_reporting: o.n, moveins: o.total, autobilled: o.count, pct: o.total ? +(o.count / o.total * 100).toFixed(1) : null }));

const bySite = {};
for (const r of autobillRows) { (bySite[r.site_code] ??= []).push(r.pct); }
const siteSpread = Object.entries(bySite).map(([code, pcts]) => ({
  code, samples: pcts.length, min: Math.min(...pcts), max: Math.max(...pcts), avg: +(pcts.reduce((a, b) => a + b, 0) / pcts.length).toFixed(1),
})).sort((a, b) => (b.max - b.min) - (a.max - a.min));

// --- 2) Insurance Conversion: raw per-site counts, current month ---
const { data: mioRows, error: mioErr } = await admin.from('raw_report').select('site_code,data').eq('month', curMonthKey).eq('report', 'move_ins_outs');
const { data: insRows, error: insErr } = await admin.from('raw_report').select('site_code,data').eq('month', curMonthKey).eq('report', 'insurance_roll');
if (mioErr) console.error('move_ins_outs fetch failed:', mioErr.message);
if (insErr) console.error('insurance_roll fetch failed:', insErr.message);
const moveInsBySite = Object.fromEntries((mioRows || []).map(r => [r.site_code, Array.isArray(r.data?.move_in_tenant_ids) ? r.data.move_in_tenant_ids.length : 0]));
const insNewBySite = Object.fromEntries((insRows || []).map(r => [r.site_code, r.data?.insured_new_customers?.count ?? 0]));
const allCodes = Array.from(new Set([...Object.keys(moveInsBySite), ...Object.keys(insNewBySite)])).sort();
const insuranceConvBySite = allCodes.map(code => {
  const moveIns = moveInsBySite[code] || 0, insNew = insNewBySite[code] || 0;
  return { code, moveIns, insNew, pct_uncapped: moveIns ? +(insNew / moveIns * 100).toFixed(1) : null, small_denominator: moveIns > 0 && moveIns < 5 };
});
const moveInsTotal = allCodes.reduce((a, c) => a + (moveInsBySite[c] || 0), 0);
const insNewTotal = allCodes.reduce((a, c) => a + (insNewBySite[c] || 0), 0);

const out = {
  probed_at: new Date().toISOString(),
  current_month: curMonthKey,
  autobill: {
    total_rows_this_month: autobillRows.length,
    distinct_sample_dates: Object.keys(byDate).length,
    days_elapsed_this_month: now.getDate(),
    daily_portfolio_pct: dailyPortfolioPct,
    site_spread_widest_first: siteSpread,
  },
  insurance_conversion: {
    portfolio_moveIns_total: moveInsTotal,
    portfolio_insNew_total: insNewTotal,
    portfolio_pct_uncapped: moveInsTotal ? +(insNewTotal / moveInsTotal * 100).toFixed(1) : null,
    portfolio_pct_capped_as_displayed: moveInsTotal ? Math.min(100, +(insNewTotal / moveInsTotal * 100).toFixed(0)) : null,
    per_site: insuranceConvBySite,
  },
};
const outPath = new URL('../../autobill-insurance-probe.json', import.meta.url);
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`Wrote probe results to ${outPath.pathname}`);
console.log(`Autobill: ${out.autobill.distinct_sample_dates} sample day(s) out of ${out.autobill.days_elapsed_this_month} elapsed this month.`);
console.log(`Insurance Conversion portfolio: ${insNewTotal}/${moveInsTotal} = ${out.insurance_conversion.portfolio_pct_uncapped}% uncapped.`);
process.exit(0);
