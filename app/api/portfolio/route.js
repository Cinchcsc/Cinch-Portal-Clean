// Clean JSON API for the NEW frontend (Claude Design rebuild). Unlike /api/bootstrap (which emits
// `window.X = ...` script for the legacy HTML), this returns the modern buildPayload() shape
// verbatim as real JSON — one field name per metric, no reshaping, no recomputation. The new
// frontend should read `totals` / `sites` / `monthly` / `history` directly rather than deriving
// its own numbers client-side.
import { NextResponse } from 'next/server';
import { admin } from '../../../lib/supabaseAdmin.js';
import { readPortalPayload, readPortalPayloadFreshCurrentMonth, summarizeHistoricalMonthlyCoverage } from '../../../lib/portalPayload.js';
import { aggregateTotals, buildPayloadRange } from '../../../lib/buildPayload.js';
import { reportingCurrentMonthStart } from '../../../lib/reportingPeriod.js';
import { extractNamedTable } from '../../../lib/sitelink.js';
import { retryOnStatementTimeout } from '../../../lib/supabaseRetry.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// FIXED 27 Jul 2026 (production audit): the default unscoped read path now merges a fresh live
// current-month buildPayloadRange() slice into the stored payload at request time (see
// readPortalPayloadFreshCurrentMonth()), which can take ~13s cold. Without an explicit route
// budget, production can time out the read and make portal-v2 fall back to mock data even though
// the underlying stored/raw data is healthy. Match the cron/read routes' explicit serverless budget
// so ordinary end-user reads have enough time to complete.
export const maxDuration = 300;

const AUTHENTICATED_NO_STORE = 'private, no-store';
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? ''));

function parseMonthStart(monthKey) {
  if (!/^\d{4}-\d{2}$/.test(String(monthKey || ''))) return null;
  const [y, m] = String(monthKey).split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) return null;
  return new Date(y, m - 1, 1);
}

function normalizePortfolioPayload(payload) {
  if (!payload || typeof payload !== 'object' || !payload.totals) return null;
  const sites = Array.isArray(payload.sites) ? payload.sites : [];
  if (!sites.length) return null;
  const currentMonth = payload.current_month || null;
  const months = Array.isArray(payload.months) && payload.months.length
    ? payload.months
    : (currentMonth ? [currentMonth] : []);
  const monthly = payload.monthly && typeof payload.monthly === 'object' ? payload.monthly : {};
  if (currentMonth && !monthly[currentMonth]?.length) monthly[currentMonth] = sites;
  return {
    ...payload,
    generated_at: payload.generated_at || null,
    current_month: currentMonth,
    prev_month: payload.prev_month || null,
    months,
    sites,
    totals: payload.totals,
    history: Array.isArray(payload.history) ? payload.history : [],
    monthly,
    range: payload.range && typeof payload.range === 'object' ? payload.range : null,
  };
}

function slicePortfolioPayloadToRange(payload, from, to, { includeMonthly = false } = {}) {
  const normalized = normalizePortfolioPayload(payload);
  if (!normalized) return null;
  const rangeMonths = (normalized.months || []).filter((month) => month >= from && month <= to);
  const currentMonthKey = normalized.current_month || null;
  const singleCurrentMonth = rangeMonths.length === 1 && currentMonthKey && rangeMonths[0] === currentMonthKey;
  const history = (normalized.history || []).filter((row) => row?.month && row.month >= from && row.month <= to);
  const monthly = includeMonthly
    ? Object.fromEntries(
        rangeMonths
          .map((month) => {
            if (month === currentMonthKey && singleCurrentMonth) return [month, normalized.sites || []];
            return [month, Array.isArray(normalized.monthly?.[month]) ? normalized.monthly[month] : []];
          }),
      )
    : {};
  return {
    ...normalized,
    current_month: rangeMonths[rangeMonths.length - 1] || normalized.current_month || null,
    prev_month: rangeMonths.length >= 2 ? rangeMonths[rangeMonths.length - 2] : null,
    months: rangeMonths,
    history,
    monthly,
    range: { from, to },
  };
}

function summarizePortfolioCompleteness(payload, { monthlyDetailAvailable = true } = {}) {
  const sites = Array.isArray(payload?.sites) ? payload.sites : [];
  const missingSites = sites
    .filter((site) => site?.__padded_missing_site)
    .map((site) => site?.code || site?.name)
    .filter(Boolean);
  // FIXED 10 Aug 2026 (WIP audit, ahead of this landing): summarizeHistoricalMonthlyCoverage() reads
  // an empty `.monthly` map as "every one of these months is missing" — the right read for the
  // STORED payload (`.monthly` is always persisted there), but wrong for a buildPayloadRange()/
  // slicePortfolioPayloadToRange() result, where `.monthly` is deliberately left `{}` unless the
  // caller passed detail=1/includeMonthly (a perf optimisation, not a data gap — see those functions'
  // own includeMonthly guards). page.js's main range fetch (fetchLiveRange) never passes detail=1, so
  // without this flag every plain multi-month view — 3M/6M/12M/YTD/All, or any single non-current
  // month — reported every month but the last as "incomplete" and tripped the new amber "Partial
  // data" banner for completely healthy data. When detail wasn't fetched we genuinely don't know
  // either way, so default to NOT flagging rather than falsely accusing it.
  const incompleteMonths = monthlyDetailAvailable
    ? [...summarizeHistoricalMonthlyCoverage(payload, { excludeMonth: payload?.current_month || null }).incompleteMonths].sort()
    : [];
  return {
    complete: missingSites.length === 0 && incompleteMonths.length === 0,
    missing_sites: missingSites,
    incomplete_months: incompleteMonths,
  };
}

function monthKeyFromDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function dayKeyFromDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function previousMonthKey(monthStart) {
  return monthKeyFromDate(new Date(monthStart.getFullYear(), monthStart.getMonth() - 1, 1)).slice(0, 7);
}

function inquiryChannelKey(label) {
  return String(label ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');
}

function sourceDayKey(value) {
  const raw = String(value ?? '').trim();
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function buildHistoricalLeadFunnelVisibleStats(rawResponse, monthStart, monthEnd) {
  const startKey = dayKeyFromDate(monthStart);
  const endKey = dayKeyFromDate(monthEnd);
  const channels = {};
  let total = 0;
  let converted = 0;
  let reservationStageCount = 0;
  let reservationMadeVisible = 0;
  for (const row of extractNamedTable(rawResponse, 'Activity')) {
    const placedDay = sourceDayKey(row?.dPlaced);
    const isReservationStage = String(row?.sRentalType ?? '').trim().toLowerCase() === 'reservation';
    if (isReservationStage && placedDay && placedDay >= startKey && placedDay <= endKey) reservationStageCount++;
    if (isReservationStage) {
      const convertedDay = sourceDayKey(row?.dConverted_ToRsv);
      if (convertedDay && convertedDay >= startKey && convertedDay <= endKey) reservationMadeVisible++;
    }
    if (!placedDay || placedDay < startKey || placedDay > endKey) continue;
    const channel = inquiryChannelKey(row?.sInquiryType);
    if (channel !== 'phone' && channel !== 'walkin' && channel !== 'web') continue;
    total++;
    const label = channel === 'walkin' ? 'WalkIn' : channel[0].toUpperCase() + channel.slice(1);
    const channelRow = (channels[label] ??= { enquiries: 0, converted: 0 });
    channelRow.enquiries++;
    if (yes(row?.iInquiryConvertedToLease) || yes(row?.iReservationConvertedToLease)) {
      converted++;
      channelRow.converted++;
    }
  }
  return { total, converted, channels, reservationStageCount, reservationMadeVisible };
}

async function fetchHistoricalLeadFunnelRepairs(monthStart) {
  const monthKey = monthKeyFromDate(monthStart);
  const end = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
  const { data, error } = await retryOnStatementTimeout(async () => admin
    .from('raw_report')
    .select('site_code,raw_response,pulled_at')
    .eq('report', 'lead_funnel')
    .eq('month', monthKey)
    .order('pulled_at', { ascending: false }));
  if (error) throw new Error(error.message);
  const bySite = new Map();
  for (const row of data || []) {
    if (!row?.site_code || bySite.has(row.site_code) || !row.raw_response) continue;
    const visible = buildHistoricalLeadFunnelVisibleStats(row.raw_response, monthStart, end);
    bySite.set(row.site_code, visible);
  }
  return { bySite };
}

function overlayHistoricalLeadFunnel(sites, bySite) {
  if (!Array.isArray(sites) || !bySite?.size) return sites;
  return sites.map((site) => {
    const lf = bySite.get(site?.code);
    if (!lf) return site;
    const enquiries = site?.enquiries && typeof site.enquiries === 'object' ? site.enquiries : {};
    return {
      ...site,
      reservationsMade: lf.reservationMadeVisible ?? lf.reservationStageCount ?? site?.reservationsMade ?? 0,
      enquiries: {
        ...enquiries,
        total: lf.total,
        reservationConversions: lf.converted,
        reservationConversionBase: lf.total,
        phone: lf.channels.Phone?.enquiries || 0,
        walkin: lf.channels.WalkIn?.enquiries || 0,
        web: lf.channels.Web?.enquiries || 0,
        webOnly: lf.channels.Web?.enquiries || 0,
        email: 0,
        channels: lf.channels,
      },
    };
  });
}

// Global month/date-range selector (Michael, 6 Jul 2026): ?month=YYYY-MM for a single month, or
// ?from=YYYY-MM&to=YYYY-MM for a range (from===to === the single-month case). When either is
// present this computes the payload LIVE from already-stored raw_report data (buildPayloadRange() —
// no SiteLink calls, nothing written to portal_payload) instead of serving the persisted current-
// month payload. Omit both params to get the normal, unchanged default behavior.
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const month = searchParams.get('month');
    const from = searchParams.get('from') || month;
    const to = searchParams.get('to') || month;
    const includeMonthly = searchParams.get('detail') === '1';
    const reportingMonth = reportingCurrentMonthStart();
    const realCurrentMonth = `${reportingMonth.getFullYear()}-${String(reportingMonth.getMonth() + 1).padStart(2, '0')}`;

    if (from && to) {
      const fromStart = parseMonthStart(from);
      const toStart = parseMonthStart(to);
      if (!fromStart || !toStart) {
        return NextResponse.json({ configured: false, complete: false, missing_sites: [], incomplete_months: [], error: 'Invalid month format, expected YYYY-MM' }, { status: 400, headers: { 'Cache-Control': AUTHENTICATED_NO_STORE } });
      }
      if (from > to) {
        return NextResponse.json({ configured: false, complete: false, missing_sites: [], incomplete_months: [], error: 'Invalid range: from must be before or equal to to' }, { status: 400, headers: { 'Cache-Control': AUTHENTICATED_NO_STORE } });
      }
      if (from > realCurrentMonth || to > realCurrentMonth) {
        return NextResponse.json({ configured: false, complete: false, missing_sites: [], incomplete_months: [], error: `Future months are not available yet; latest reportable month is ${realCurrentMonth}` }, { status: 400, headers: { 'Cache-Control': AUTHENTICATED_NO_STORE } });
      }
      // Production hardening (28 Jul 2026): selecting the visible current month explicitly in the
      // picker should return the exact same already-fresh current slice as the default route, not
      // force an unnecessary full buildPayloadRange(current,current) live rebuild. The default read
      // path now keeps a fresh stored fallback and only rebuilds when needed; re-running the heavy
      // current-month raw_response scan here was still exposing picker clicks to intermittent
      // statement-timeout / 52x failures for no user-visible benefit.
      if (from === realCurrentMonth && to === realCurrentMonth) {
        const result = await readPortalPayloadFreshCurrentMonth();
        const payload = slicePortfolioPayloadToRange(result?.payload, from, to, { includeMonthly });
        if (!payload) {
          return NextResponse.json(
            { configured: false, complete: false, missing_sites: [], incomplete_months: [], generated_at: null, current_month: null, prev_month: null, months: [], sites: [], totals: null, history: [], monthly: {}, range: null, error: 'No stored data is available for the requested current month' },
            { headers: { 'Cache-Control': AUTHENTICATED_NO_STORE } },
          );
        }
        const completeness = summarizePortfolioCompleteness(payload, { monthlyDetailAvailable: includeMonthly });
        return NextResponse.json(
          { configured: true, ...completeness, ...payload },
          { headers: { 'Cache-Control': AUTHENTICATED_NO_STORE } },
        );
      }
      const payload = normalizePortfolioPayload(await buildPayloadRange(fromStart, toStart, { includeMonthly }));
      if (!payload) {
        return NextResponse.json(
          { configured: false, complete: false, missing_sites: [], incomplete_months: [], generated_at: null, current_month: null, prev_month: null, months: [], sites: [], totals: null, history: [], monthly: {}, range: null, error: 'No stored data is available for the requested month range' },
          { headers: { 'Cache-Control': AUTHENTICATED_NO_STORE } },
        );
      }
      const completeness = summarizePortfolioCompleteness(payload, { monthlyDetailAvailable: includeMonthly });
      // RESTORED 10 Aug 2026 (Supabase free-tier egress check: 4.25/5GB used this billing cycle,
      // grace period already over per the dashboard's own banner — "projects will not be able to
      // serve requests when you use up your quota"). Codex's WIP had moved every branch of this route
      // to no-store, including fully closed historical ranges that carry zero freshness risk. That
      // matches the exact problem the 16 Jul 2026 fix already solved once (see the CACHED comments
      // this WIP removed) — bringing back the historical-only half of that fix, not the whole
      // decision: `to` is already validated <= realCurrentMonth above, and ranges are contiguous, so
      // `to === realCurrentMonth` is the only way this specific range can still include the live,
      // in-progress month — that case (and the exact-current-month branch above) stays no-store.
      // Every other, fully-closed range is safe to cache: this data only changes a few times a day via
      // the rebuild/pull crons, and the auth middleware still gates every request regardless of
      // whether Vercel's edge serves this from cache or hits the route itself.
      const touchesCurrentMonth = to === realCurrentMonth;
      return NextResponse.json(
        { configured: true, ...completeness, ...payload },
        { headers: { 'Cache-Control': touchesCurrentMonth ? AUTHENTICATED_NO_STORE : 'public, s-maxage=120, stale-while-revalidate=600' } },
      );
    }

    // FIXED 24 Jul 2026 (auto-update audit): this route used to trigger a FULL portal_payload rebuild
    // inline on an ordinary page read whenever the stored row lagged behind the latest current-month
    // raw_report pull. In practice that means the FIRST person opening the portal in the morning could
    // end up paying for a heavy rebuild inside /api/portfolio itself, exactly where we saw intermittent
    // `statement timeout` / stale-morning behavior. Current-month page data already comes from the
    // separate live buildPayloadRange() path above, so user reads should not own rebuild freshness.
    // Scheduled /api/rebuild-payload crons own keeping portal_payload fresh instead.
    const result = await readPortalPayloadFreshCurrentMonth();
    if (!result?.payload) {
      return NextResponse.json(
        { configured: false, complete: false, missing_sites: [], incomplete_months: [], generated_at: null, current_month: null, months: [], sites: [], totals: null, history: [], monthly: {} },
        { headers: { 'Cache-Control': AUTHENTICATED_NO_STORE } },
      );
    }
    const payload = normalizePortfolioPayload(result.payload);
    if (!payload) {
      return NextResponse.json(
        { configured: false, complete: false, missing_sites: [], incomplete_months: [], generated_at: null, current_month: null, prev_month: null, months: [], sites: [], totals: null, history: [], monthly: {}, range: null, error: 'Stored portal payload is malformed or incomplete' },
        { headers: { 'Cache-Control': AUTHENTICATED_NO_STORE } },
      );
    }
    const completeness = summarizePortfolioCompleteness(payload);
    // RESTORED 10 Aug 2026 (same Supabase free-tier egress check as the ranged branch above: 4.25/5GB
    // used, grace period over). This is the highest-impact branch to restore — it's the ONE unscoped
    // read fetchLiveTotals() in page.js calls on every single page load and nav click across the whole
    // portal, unconditionally, so it was flagged as "the biggest single lever" when this caching was
    // first added on 16 Jul 2026. readPortalPayloadFreshCurrentMonth() already merges a live current-
    // month slice in before this point, so the cached response is never staler than that merge — this
    // cache only avoids re-paying for that same work on every repeat view within the window.
    return NextResponse.json(
      { configured: true, ...completeness, ...payload },
      { headers: { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=600' } },
    );
  } catch (error) {
    return NextResponse.json({ configured: false, complete: false, missing_sites: [], incomplete_months: [], error: error.message }, { status: 500, headers: { 'Cache-Control': AUTHENTICATED_NO_STORE } });
  }
}
