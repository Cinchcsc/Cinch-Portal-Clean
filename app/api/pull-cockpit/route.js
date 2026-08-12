// Vercel cron (see vercel.json, scheduled 0 8 * * * — its own hour, same reasoning as every other
// cron entry there) triggers the Cockpit Charting daily pull. Mirrors app/api/pull-snapshot/route.js's
// auth/runtime pattern exactly. Can still be run manually any time via `npm run pull:cockpit`.
import { NextResponse } from 'next/server';
import { runCockpitPull } from '../../../lib/pullCockpit.js';

export const runtime = 'nodejs';        // the SOAP client needs the Node runtime, not Edge
export const dynamic = 'force-dynamic';
export const maxDuration = 300;         // One FinancialSummary call per site (29 calls total), with
                                         // enough headroom for retries on transient upstream errors.

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
    const result = await runCockpitPull({ triggerLabel: `${u.pathname}${u.search || ''} ua=${(request.headers.get('user-agent') || 'unknown').replace(/\s+/g, ' ').trim()}` });
    return NextResponse.json(result, { status: statusCodeForJob(result) });
  } catch (e) {
    return NextResponse.json({ status: 'error', message: e.message }, { status: 500 });
  }
}
