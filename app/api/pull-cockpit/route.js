// Vercel cron (see vercel.json, scheduled 0 7 * * * — its own hour, same reasoning as every other
// cron entry there) triggers the Cockpit Charting daily pull. Mirrors app/api/pull-snapshot/route.js's
// auth/runtime pattern exactly. Can still be run manually any time via `npm run pull:cockpit`.
import { NextResponse } from 'next/server';
import { runCockpitPull } from '../../../lib/pullCockpit.js';

export const runtime = 'nodejs';        // the SOAP client needs the Node runtime, not Edge
export const dynamic = 'force-dynamic';
export const maxDuration = 300;         // 300s is Hobby's default+max too via Fluid Compute (checked
                                         // live against Vercel's docs 14 Jul 2026) — not Pro-only.
                                         // One FinancialSummary call per site (29 calls total), well
                                         // within budget regardless of plan.

export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    return NextResponse.json(await runCockpitPull());
  } catch (e) {
    return NextResponse.json({ status: 'error', message: e.message }, { status: 500 });
  }
}
