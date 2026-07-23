// Clean JSON API for the NEW frontend (Claude Design rebuild). Unlike /api/bootstrap (which emits
// `window.X = ...` script for the legacy HTML), this returns the modern buildPayload() shape
// verbatim as real JSON — one field name per metric, no reshaping, no recomputation. The new
// frontend should read `totals` / `sites` / `monthly` / `history` directly rather than deriving
// its own numbers client-side.
import { NextResponse } from 'next/server';
import { readPortalPayload } from '../../../lib/portalPayload.js';
import { buildPayloadRange } from '../../../lib/buildPayload.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
    const realCurrentMonth = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;

    if (from && to) {
      const [fy, fm] = from.split('-').map(Number);
      const [ty, tm] = to.split('-').map(Number);
      if (!fy || !fm || !ty || !tm) {
        return NextResponse.json({ configured: false, error: 'Invalid month format, expected YYYY-MM' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
      }
      const payload = await buildPayloadRange(new Date(fy, fm - 1, 1), new Date(ty, tm - 1, 1));
      // FIXED 23 Jul 2026 (live portal audit): the current in-progress month must never be served from
      // edge cache. Local buildPayloadRange() for 2026-07 was correct (e.g. Bicester enquiries=91),
      // but the live production Marketing page was serving a July-labeled response with June-shaped
      // figures (e.g. Bicester enquiries=137, exactly our June number). The safest narrow fix is to
      // keep caching for closed historical ranges, but fail CLOSED to `no-store` for any range that
      // touches the real current calendar month, so a stale cached range response can never masquerade
      // as the latest live month again.
      const touchesCurrentMonth = from <= realCurrentMonth && to >= realCurrentMonth;
      // CACHED 16 Jul 2026 (Michael: Supabase egress over the free-tier 5GB limit) — this used to be
      // 'no-store' on every branch, so every dashboard load/nav-click re-read portal_payload's full
      // ~6.87MB row (or re-scanned raw_report for a range) straight from Supabase with zero caching in
      // front of it. The underlying data only changes a few times a day (cron pulls), so there's no
      // freshness reason to hit Supabase on every request — a short edge cache absorbs repeat views of
      // the same month/range (people refreshing, switching between pages, teammates opening the same
      // dashboard) without ever showing data older than the last cron pull anyway. 120s hard cache +
      // 10min stale-while-revalidate: Vercel's edge can keep serving instantly while it quietly
      // refetches in the background, so this never blocks a request on a slow origin hit either.
      return NextResponse.json(
        { configured: true, ...payload },
        { headers: { 'Cache-Control': touchesCurrentMonth ? 'no-store' : 'public, s-maxage=120, stale-while-revalidate=600' } },
      );
    }

    const result = await readPortalPayload({ ensureFresh: true });
    if (!result?.payload) {
      return NextResponse.json(
        { configured: false, generated_at: null, current_month: null, months: [], sites: [], totals: null, history: [], monthly: {} },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
    // CACHED 16 Jul 2026 — see comment above; this unscoped branch is the biggest single lever since
    // it serves the full ~6.87MB portal_payload row and is called on every page load/nav-click purely
    // for month-list metadata (fetchLiveTotals() in page.js).
    return NextResponse.json(
      { configured: true, ...result.payload },
      { headers: { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=600' } },
    );
  } catch (error) {
    return NextResponse.json({ configured: false, error: error.message }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
