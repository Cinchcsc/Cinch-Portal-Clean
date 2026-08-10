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
import { PORTAL_SITE_CODES } from './buildPayload.js';
import { readPortalPayloadFreshCurrentMonth } from './portalPayload.js';
import { lastCompleteDay, reportingCurrentMonthStart } from './reportingPeriod.js';
import { retryOnStatementTimeout } from './supabaseRetry.js';

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate(); // m is 0-indexed
const MONTH_RE = /^\d{4}-\d{2}$/;

function parseMonthStart(monthKey) {
  if (typeof monthKey !== 'string' || !MONTH_RE.test(monthKey)) return null;
  const [y, m] = monthKey.split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) return null;
  return new Date(y, m - 1, 1);
}

function fillMissingSiteSnapshots(days) {
  const lastBySite = new Map();
  return days.map((day) => {
    const present = new Map((day.sites || []).map((site) => [site.code, site]));
    for (const [code, prior] of lastBySite.entries()) {
      if (!present.has(code)) present.set(code, prior);
    }
    const sites = Array.from(present.values()).sort((a, b) => String(a.code || '').localeCompare(String(b.code || '')));
    for (const site of sites) lastBySite.set(site.code, site);
    return {
      ...day,
      total_charge: sites.reduce((sum, site) => sum + (Number(site.total_charge) || 0), 0),
      total_payment: sites.reduce((sum, site) => sum + (Number(site.total_payment) || 0), 0),
      total_credit: sites.reduce((sum, site) => sum + (Number(site.total_credit) || 0), 0),
      sites,
    };
  });
}

function syncLatestCurrentMonthCockpitPoint(curve, portalPayload, currentMonthKey, currentDayKey) {
  if (!Array.isArray(curve) || !portalPayload?.sites?.length || currentMonthKey !== portalPayload.current_month) {
    return { curve, synced: false };
  }
  const sites = portalPayload.sites
    .map((site) => ({
      code: site.code,
      total_charge: Number(site.revenue?.charge) || 0,
      total_payment: Number(site.revenue?.payment) || 0,
      total_credit: Number(site.revenue?.credit) || 0,
      categories: Array.isArray(site.revenue?.categories) ? site.revenue.categories : [],
    }))
    .sort((a, b) => String(a.code || '').localeCompare(String(b.code || '')));
  const syncedPoint = {
    date: currentDayKey,
    total_charge: sites.reduce((sum, site) => sum + site.total_charge, 0),
    total_payment: sites.reduce((sum, site) => sum + site.total_payment, 0),
    total_credit: sites.reduce((sum, site) => sum + site.total_credit, 0),
    sites,
  };
  const existingIdx = curve.findIndex((row) => row?.date === currentDayKey);
  // Production hardening (28 Jul 2026, continued audit): this sync is meant to reconcile the
  // already-stored cockpit curve's LATEST complete-day point with the main portal's repaired
  // current-month financial totals, not to fabricate a cockpit day that daily_financial_snapshot
  // never actually captured. If the daily snapshot store has no row for `currentDayKey` yet, adding
  // one here would make the widget look configured from a different source entirely and hide a
  // missing/late cockpit pull. Only replace an existing stored day; never append a synthetic one.
  if (existingIdx < 0) return { curve, synced: false };
  const next = curve.slice();
  next[existingIdx] = syncedPoint;
  return {
    curve: next.sort((a, b) => String(a?.date || '').localeCompare(String(b?.date || ''))),
    synced: true,
  };
}

export async function readCockpitData(monthKey) {
  const now = reportingCurrentMonthStart();
  const defaultTarget = new Date(now.getFullYear(), now.getMonth(), 1);
  const requested = parseMonthStart(monthKey);
  // Clamp direct future-month requests back to the latest reportable month. The normal UI no longer
  // exposes future months, but this keeps the API itself from returning a month label/pacing window
  // for a period that cannot yet have any complete-day cockpit data.
  const target = requested && requested.getTime() <= defaultTarget.getTime() ? requested : defaultTarget;
  const monthStart = new Date(target.getFullYear(), target.getMonth(), 1);
  const monthEnd = new Date(target.getFullYear(), target.getMonth() + 1, 1);

  // 1. This month's accumulated daily snapshots, across all sites.
  // total_credit — ADDED 17 Jul 2026 (task #312) alongside total_charge/total_payment, so the curve
  // can also expose Charge-minus-Credit ("Revenue Collected", same definition as buildPayload.js's
  // revenue.collected) at daily granularity, not just raw total_charge.
  const { data: rows, error } = await retryOnStatementTimeout(async () => admin
    .from('daily_financial_snapshot')
    .select('site_code,snapshot_date,total_charge,total_payment,total_credit,categories,pulled_at')
    .gte('snapshot_date', ymd(monthStart))
    .lt('snapshot_date', ymd(monthEnd))
    .order('snapshot_date'));
  if (error) throw new Error(error.message);
  const { data: sitesRef, error: sitesErr } = await retryOnStatementTimeout(async () => admin
    .from('sites')
    .select('code'));
  if (sitesErr) {
    console.warn('[cockpitData] sites reference read failed; falling back to built-in portal site list:', sitesErr.message);
  }
  const expectedSiteCount = sitesErr
    ? PORTAL_SITE_CODES.length
    : new Set((sitesRef || []).map((row) => row?.code).filter(Boolean)).size;

  // Portfolio-wide per-day total (sum across sites for each snapshot_date), plus per-site rows kept
  // for the store filter to slice client-side (mirrors every other widget's "raw arrays, filter/sum
  // in the frontend" convention — see app/portal-v2/page.js's computeTotals()).
  const byDate = {};
  for (const r of rows || []) {
    const o = (byDate[r.snapshot_date] ??= { date: r.snapshot_date, total_charge: 0, total_payment: 0, total_credit: 0, sites: [] });
    o.total_charge += Number(r.total_charge) || 0;
    o.total_payment += Number(r.total_payment) || 0;
    o.total_credit += Number(r.total_credit) || 0;
    o.sites.push({
      code: r.site_code,
      total_charge: Number(r.total_charge) || 0,
      total_payment: Number(r.total_payment) || 0,
      total_credit: Number(r.total_credit) || 0,
      categories: r.categories || [],
    });
  }
  const completeDays = Object.values(byDate)
    .filter((day) => {
      const distinctSites = new Set((day.sites || []).map((site) => site.code).filter(Boolean)).size;
      return !expectedSiteCount || distinctSites >= expectedSiteCount;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  // Production audit fix (27 Jul 2026): daily_financial_snapshot is one row per site per day, and a
  // partial day's import can legitimately miss some sites while still leaving earlier days intact.
  // The curve represents cumulative month-to-date totals, so dropping absent sites from a later day
  // makes the portfolio line fall backward impossibly (confirmed on 24 Jul 2026: 14/29 sites present,
  // total_charge plunging from 1,173,532 to 734,704). Carry each missing site's last known cumulative
  // snapshot forward until a newer row exists, matching the chart's existing "carry forward missing
  // days" semantics at the per-site level too.
  // Continued hardening (28 Jul 2026): carrying sites forward only makes sense on days whose
  // snapshot import itself completed across the full site universe. If a day's stored snapshot is
  // genuinely partial (for example 14/29 sites on 24 Jul 2026), keeping that date in the curve still
  // understates the month-to-date total while looking superficially valid. Drop incomplete dates
  // entirely; the page already pads missing calendar days visually, which is safer than plotting a
  // false partial portfolio total.
  let curve = fillMissingSiteSnapshots(completeDays);
  const targetMonthKey = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}`;
  const currentCompleteDayKey = ymd(lastCompleteDay(new Date()));
  const isCurrentVisibleMonth = targetMonthKey === `${defaultTarget.getFullYear()}-${String(defaultTarget.getMonth() + 1).padStart(2, '0')}`;
  let syncedPortalGeneratedAt = null;
  if (isCurrentVisibleMonth) {
    try {
      // Cross-widget consistency fix (28 Jul 2026): the portal's current-month financial widgets now
      // read the repaired/raw_report-based current slice, while daily_financial_snapshot is a separate
      // once-per-day store that can lag or disagree on the latest complete day. For the currently
      // visible month only, force the latest cockpit point onto the exact same current-month financial
      // totals the main portal serves, so District Manager and Financial widgets cannot contradict
      // each other for the same store/day window.
      const portal = await readPortalPayloadFreshCurrentMonth();
      const synced = syncLatestCurrentMonthCockpitPoint(curve, portal?.payload, targetMonthKey, currentCompleteDayKey);
      curve = synced.curve;
      syncedPortalGeneratedAt = synced.synced ? (portal?.generatedAt || portal?.payload?.generated_at || null) : null;
    } catch (error) {
      console.warn('[cockpitData] current-month cockpit/latest portal sync failed; keeping stored cockpit curve as-is:', error?.message || error);
    }
  }
  const completeDaySet = new Set(completeDays.map((day) => day.date));
  const generatedAtMs = (rows || []).reduce((latest, r) => {
    if (!completeDaySet.has(r.snapshot_date)) return latest;
    const ts = r.pulled_at ? new Date(r.pulled_at).getTime() : 0;
    return ts > latest ? ts : latest;
  }, 0);
  const syncedPortalGeneratedAtMs = syncedPortalGeneratedAt ? new Date(syncedPortalGeneratedAt).getTime() : 0;

  const latestCurveDate = curve.length ? String(curve[curve.length - 1]?.date || '') : null;
  // A historical month with zero stored daily_financial_snapshot rows is NOT "complete" just because
  // it is not the live current month. That false positive made the District Manager page report an
  // empty cockpit month as complete even when `configured:false`, `curve:[]`, and `generated_at:null`.
  // For the visible current month we still require the latest complete day point; for older months,
  // require at least one stored curve point before calling the dataset complete.
  const complete = isCurrentVisibleMonth
    ? latestCurveDate === currentCompleteDayKey
    : curve.length > 0;

  // 2. Last 3 CLOSED months' financial totals (already-pulled monthly data, raw_report).
  const closedMonths = [];
  for (let i = 1; i <= 3; i++) {
    const d = new Date(target.getFullYear(), target.getMonth() - i, 1);
    closedMonths.push({ y: d.getFullYear(), m: d.getMonth(), key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01` });
  }
  const { data: finRows, error: finErr } = await retryOnStatementTimeout(async () => admin
    .from('raw_report').select('month,data')
    .eq('report', 'financial')
    .in('month', closedMonths.map((c) => c.key)));
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
  // Require all 3 closed lookback months for a true "3-month average pace". Using 1-2 months here
  // would silently mislabel a partial-history average as the full 3-month benchmark shown in the UI.
  const avgDailyRate = dailyRates.length === 3 ? dailyRates.reduce((a, b) => a + b, 0) / dailyRates.length : null;

  return {
    month: `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}`,
    curve,               // [{date, total_charge, total_payment, sites:[{code,total_charge,categories}]}, ...]
    avgDailyRate,        // £/day — multiply by day-of-month for the comparison pace line
    generated_at: Math.max(generatedAtMs, syncedPortalGeneratedAtMs) ? new Date(Math.max(generatedAtMs, syncedPortalGeneratedAtMs)).toISOString() : null,
    closedMonthsUsed: dailyRates.length,
    complete,
  };
}
