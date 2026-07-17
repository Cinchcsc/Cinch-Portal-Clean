// Vercel cron (see vercel.json — its own hour, scheduled safely after every report-pulling batch has
// had its own full hour to finish) triggers JUST the portal_payload rebuild, decoupled from
// app/api/pull/route.js's SiteLink pulling — see lib/pull.js's `rebuildPayload` option comment and
// lib/rebuildPayload.js for the full task #297 root-cause explanation. Mirrors app/api/pull/route.js's
// auth/runtime pattern exactly. Can still be run manually any time via `npm run rebuild:payload`.
import { NextResponse } from 'next/server';
import { runRebuildPayload } from '../../../lib/rebuildPayload.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// buildPayload() alone (no SiteLink calls, just reading raw_report + recomputing) should comfortably
// fit well under 300s even for the full 29-site/multi-year history — but this is the first time it's
// ever run WITHOUT sharing its budget with ~100 SiteLink calls first, so watch this route's own
// duration in refresh_log (kind='rebuild') for the first few days to confirm.
export const maxDuration = 300;

export async function GET(request) {
  // Same fail-closed CRON_SECRET check as every other cron route (16 Jul 2026 pentest follow-up).
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    return NextResponse.json(await runRebuildPayload());
  } catch (e) {
    return NextResponse.json({ status: 'error', message: e.message }, { status: 500 });
  }
}
