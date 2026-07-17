// Reader for Cockpit Charting (task #174/#207) — assembles the two things the chart needs from raw
// storage, no live SiteLink calls (those only happen in lib/pullCockpit.js):
//   1. This month's day-by-day cumulative income curve, from daily_financial_snapshot's accumulated
//      rows (see that table's schema comment for why it's a real growing time series, unlike
//      snapshot_payload's single overwritten row).
//   2. A 3-month-average PACE line to compare it against — Michael's Qstrom screenshots show this as
//      a straight reference line, not a real historical daily curve (we don't have daily history
//      before this feature existed). Derived from the last 3 CLOSED months' already-pulled monthly
//      `financial` report totals (lib/reportMap.js): avg(month total ÷ days in that month), then
//      scaled by day-of-month for the current curve's x-axis, so day 15 compares against "day 15 of
//      an average month" rather than a full month total.
import { admin } from './supabaseAdmin.js';

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate(); // m is 0-indexed

export async function readCockpitData() {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  // 1. This month's accumulated daily snapshots, across all sites.
  // total_credit — ADDED 17 Jul 2026 (task #312) alongside total_charge/total_payment, so the curve
  // can also expose Charge-minus-Credit ("Revenue Collected", same definition as buildPayload.js's
  // revenue.collected) at daily granularity, not just raw total_charge.
  const { data: rows, error } = await admin
    .from('daily_financial_snapshot')
    .select('site_code,snapshot_date,total_charge,total_payment,total_credit,categories')
    .gte('snapshot_date', ymd(monthStart))
    .lt('snapshot_date', ymd(new Date(now.getFullYear(), now.getMonth() + 1, 1)))
    .order('snapshot_date');
  if (error) throw new Error(error.message);

  // Portfolio-wide per-day total (sum across sites for each snapshot_date), plus per-site rows kept
  // for the store filter to slice client-side (mirrors every other widget's "raw arrays, filter/sum
  // in the frontend" convention — see app/portal-v2/page.js's computeTotals()).
  const byDate = {};
  for (const r of rows || []) {
    const o = (byDate[r.snapshot_date] ??= { date: r.snapshot_date, total_charge: 0, total_payment: 0, total_credit: 0, sites: [] });
    o.total_charge += Number(r.total_charge) || 0;
    o.total_payment += Number(r.total_payment) || 0;
    o.total_credit += Number(r.total_credit) || 0;
    o.sites.push({ code: r.site_code, total_charge: Number(r.total_charge) || 0, total_credit: Number(r.total_credit) || 0, categories: r.categories || [] });
  }
  const curve = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));

  // 2. Last 3 CLOSED months' financial totals (already-pulled monthly data, raw_report).
  const closedMonths = [];
  for (let i = 1; i <= 3; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    closedMonths.push({ y: d.getFullYear(), m: d.getMonth(), key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01` });
  }
  const { data: finRows, error: finErr } = await admin
    .from('raw_report').select('month,data')
    .eq('report', 'financial')
    .in('month', closedMonths.map((c) => c.key));
  if (finErr) throw new Error(finErr.message);

  const totalsByMonth = {};
  for (const r of finRows || []) {
    const mk = String(r.month).slice(0, 10);
    const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    totalsByMonth[mk] = (totalsByMonth[mk] || 0) + (Number(d?.total_charge) || 0);
  }
  const dailyRates = closedMonths
    .filter((c) => totalsByMonth[c.key] != null)
    .map((c) => totalsByMonth[c.key] / daysInMonth(c.y, c.m));
  const avgDailyRate = dailyRates.length ? dailyRates.reduce((a, b) => a + b, 0) / dailyRates.length : 0;

  return {
    month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
    curve,               // [{date, total_charge, total_payment, sites:[{code,total_charge,categories}]}, ...]
    avgDailyRate,        // £/day — multiply by day-of-month for the comparison pace line
    closedMonthsUsed: dailyRates.length,
  };
}
