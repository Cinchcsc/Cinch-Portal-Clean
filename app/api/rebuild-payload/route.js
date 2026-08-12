// Vercel cron (see vercel.json) triggers JUST the portal_payload rebuild, decoupled from
// app/api/pull/route.js's SiteLink pulling — see lib/pull.js's `rebuildPayload` option comment and
// lib/rebuildPayload.js for the full task #297 root-cause explanation. As of Tuesday, July 28, 2026,
// this now runs multiple times daily at 03:50, 05:00, 09:00, 14:00, and 15:00 UTC. The added 03:50
// slot (12 Aug 2026, audit follow-up) catches a successful 03:40 retry of the
// merchandise/financial/rate_changes/reservations pull before the morning stored fallback payload can
// sit stale for another hour. The 05:00 run still happens as soon as the core "yesterday flow"
// reports plus Snapshot are in, so enquiries/reservations/move-ins/move-outs stop waiting for the
// later true_revenue shard chain before the portal can look fresh in the morning. The later retries
// still backstop transient DB/Supabase failures and refresh rate-sensitive widgets once the heavier
// shards and floor snapshot have landed. Each rebuild keeps its own scheduled slot so the dependency
// order stays robust even if platform cron timing drifts within the window.
// Mirrors app/api/pull/route.js's auth/runtime pattern exactly. Can still be run manually any time
// via `npm run rebuild:payload`.
import { NextResponse } from 'next/server';
import { runRebuildPayload } from '../../../lib/rebuildPayload.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// buildPayload() alone (no SiteLink calls, just reading raw_report + recomputing) should comfortably
// fit well under 300s even for the full 29-site/multi-year history — but this is the first time it's
// ever run WITHOUT sharing its budget with ~100 SiteLink calls first, so watch this route's own
// duration in refresh_log (kind='rebuild') for the first few days to confirm.
export const maxDuration = 300;

function statusCodeForJob(result) {
  switch (result?.status) {
    case 'ok':
      return 200;
    case 'skipped':
      return 409;
    case 'partial':
    case 'error':
      return 500;
    default:
      return 200;
  }
}

export async function GET(request) {
  // Same fail-closed CRON_SECRET check as every other cron route (16 Jul 2026 pentest follow-up).
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const u = new URL(request.url);
    const result = await runRebuildPayload({ triggerLabel: `${u.pathname}${u.search || ''} ua=${(request.headers.get('user-agent') || 'unknown').replace(/\s+/g, ' ').trim()}` });
    return NextResponse.json(result, { status: statusCodeForJob(result) });
  } catch (e) {
    return NextResponse.json({ status: 'error', message: e.message }, { status: 500 });
  }
}
