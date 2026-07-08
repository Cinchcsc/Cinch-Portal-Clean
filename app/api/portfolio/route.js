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

    if (from && to) {
      const [fy, fm] = from.split('-').map(Number);
      const [ty, tm] = to.split('-').map(Number);
      if (!fy || !fm || !ty || !tm) {
        return NextResponse.json({ configured: false, error: 'Invalid month format, expected YYYY-MM' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
      }
      const payload = await buildPayloadRange(new Date(fy, fm - 1, 1), new Date(ty, tm - 1, 1));
      // TEMP DIAGNOSTIC (8 Jul 2026, Michael: "bounces between 27 and 29 stores on reload, Enquiries
      // overshooting") — log every hit to this route with a timestamp + result shape, so we can see
      // in the `npm run dev` terminal, in real time, whether two near-simultaneous requests actually
      // disagree (confirming a concurrent-write/race) or whether only one ever runs per reload (which
      // would point somewhere else entirely). Remove once the bug's confirmed fixed.
      console.log(`[api/portfolio] ${new Date().toISOString()} RANGE from=${from} to=${to} -> sites=${payload.sites.length} enquiriesTotal=${(payload.sites || []).reduce((a, s) => a + ((s.enquiries && s.enquiries.total) || 0), 0)} rate=${payload.totals && payload.totals.rate}`);
      return NextResponse.json({ configured: true, ...payload }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const result = await readPortalPayload();
    if (!result?.payload) {
      console.log(`[api/portfolio] ${new Date().toISOString()} UNSCOPED -> no portal_payload row`);
      return NextResponse.json(
        { configured: false, generated_at: null, current_month: null, months: [], sites: [], totals: null, history: [], monthly: {} },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
    console.log(`[api/portfolio] ${new Date().toISOString()} UNSCOPED generated_at=${result.generatedAt} -> sites=${(result.payload.sites || []).length} enquiriesTotal=${(result.payload.sites || []).reduce((a, s) => a + ((s.enquiries && s.enquiries.total) || 0), 0)} rate=${result.payload.totals && result.payload.totals.rate}`);
    return NextResponse.json(
      { configured: true, ...result.payload },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return NextResponse.json({ configured: false, error: error.message }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
