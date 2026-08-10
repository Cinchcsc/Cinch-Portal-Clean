// Clean JSON read for the Weekly/Daily Snapshot page. Mirrors app/api/portfolio/route.js's pattern —
// reads the persisted snapshot_payload row, no live SiteLink calls (those only happen in
// lib/pullSnapshot.js via `npm run pull:snapshot` or GET /api/pull-snapshot).
import { NextResponse } from 'next/server';
import { readSnapshotPayloadFresh } from '../../../lib/snapshotPayload.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Production hardening (27 Jul 2026): this route only reads stored snapshot_payload, but a slow cold
// Supabase read should still not force the Snapshot page into mock data. Match the other read routes'
// explicit serverless budget so healthy stored data has time to return.
export const maxDuration = 300;

const AUTHENTICATED_NO_STORE = 'private, no-store';
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

function normalizeSnapshotPeriod(period) {
  if (!period || typeof period !== 'object') return null;
  const totals = period.totals && typeof period.totals === 'object' ? period.totals : null;
  const range = period.range && typeof period.range === 'object' ? period.range : null;
  if (!totals || !range) return null;
  const start = range.start || range.from || null;
  const end = range.end || range.to || null;
  if (!start || !end) return null;
  return {
    ...period,
    totals: {
      enquiries: Number(totals.enquiries) || 0,
      reservations: Number(totals.reservations) || 0,
      moveIns: Number(totals.moveIns) || 0,
      moveOuts: Number(totals.moveOuts) || 0,
      sqftIn: round2(totals.sqftIn),
      sqftOut: round2(totals.sqftOut),
    },
    range: {
      start,
      end,
      from: start,
      to: end,
    },
    sites: Array.isArray(period.sites)
      ? period.sites.map((site) => ({
          ...site,
          enquiries: Number(site?.enquiries) || 0,
          reservations: Number(site?.reservations) || 0,
          moveIns: Number(site?.moveIns) || 0,
          moveOuts: Number(site?.moveOuts) || 0,
          sqftIn: round2(site?.sqftIn),
          sqftOut: round2(site?.sqftOut),
        }))
      : [],
  };
}

export async function GET() {
  try {
    const result = await readSnapshotPayloadFresh();
    if (!result?.payload) {
      return NextResponse.json(
        { configured: false, complete: false, generated_at: null, daily: null, weekly: null, quarterly: null },
        { headers: { 'Cache-Control': AUTHENTICATED_NO_STORE } },
      );
    }
    const payload = result.payload;
    const daily = normalizeSnapshotPeriod(payload.daily);
    const weekly = normalizeSnapshotPeriod(payload.weekly);
    const quarterly = normalizeSnapshotPeriod(payload.quarterly);
    const hasAnySnapshotPeriod = !!(daily || weekly || quarterly);
    const hasCompleteSnapshotSet = !!(daily && weekly && quarterly);
    const complete = payload.complete !== false && hasCompleteSnapshotSet;
    return NextResponse.json(
      complete
        ? { configured: true, complete: true, ...payload, daily, weekly, quarterly }
        : {
            configured: hasAnySnapshotPeriod,
            complete: false,
            ...payload,
            daily,
            weekly,
            quarterly,
            error: 'Stored snapshot payload is incomplete; daily, weekly, and quarterly periods are all required',
          },
      { headers: { 'Cache-Control': AUTHENTICATED_NO_STORE } },
    );
  } catch (error) {
    return NextResponse.json({ configured: false, complete: false, error: error.message }, { status: 500, headers: { 'Cache-Control': AUTHENTICATED_NO_STORE } });
  }
}
