// Vercel cron (see vercel.json, scheduled 0 4 * * * UTC) triggers the Weekly/Daily/Quarterly
// Snapshot pull as soon as lead_funnel + move_ins_outs have finished, instead of waiting behind the
// later true_revenue/rate chain. That keeps the "yesterday" Snapshot page current earlier in the UK
// morning while still using only completed-day source data. Mirrors app/api/pull/route.js's
// auth/runtime pattern exactly. Can still be run manually any time via `npm run pull:snapshot`.
import { NextResponse } from 'next/server';
import { runSnapshotPull } from '../../../lib/pullSnapshot.js';

export const runtime = 'nodejs';        // the SOAP client needs the Node runtime, not Edge
export const dynamic = 'force-dynamic';
// 174 sequential SiteLink calls (3 periods x 2 reports x 29 sites) can take most of the available
// function window, so keep the route on the full explicit budget.
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
  // CHANGED 16 Jul 2026 (pentest follow-up — see app/api/pull/route.js for the full explanation):
  // fail CLOSED instead of open if CRON_SECRET is ever missing. Confirmed CRON_SECRET is set in
  // Vercel and this route already correctly 401s with no auth header, so no behavior change today.
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const u = new URL(request.url);
    const result = await runSnapshotPull({ triggerLabel: `${u.pathname}${u.search || ''}` });
    return NextResponse.json(result, { status: statusCodeForJob(result) });
  } catch (e) {
    return NextResponse.json({ status: 'error', message: e.message }, { status: 500 });
  }
}
