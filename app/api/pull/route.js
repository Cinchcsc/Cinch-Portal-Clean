// Vercel cron hits this route (see vercel.json). Vercel sends Authorization: Bearer $CRON_SECRET.
// Lives at /api/pull in the Next.js app.
import { NextResponse } from 'next/server';
import { runPull } from '../../../lib/pull.js';

export const runtime = 'nodejs';        // the SOAP client needs the Node runtime, not Edge
export const dynamic = 'force-dynamic';
export const maxDuration = 300;         // needs Vercel Pro; on Hobby keep DEFAULT_REPORTS small

// COST CONTROL: the full 13-report pull is ~378 SiteLink calls and won't finish inside Vercel's
// free 60s window. So the daily cron runs a LIGHT set (occupancy + rent_roll, ~81 calls) to keep
// occupancy/rates fresh; the heavy flow reports (insurance, marketing, financials, debtors, …) only
// change monthly, so run them with ?full=1 once a month (best on the Mac via `npm run pull`, no
// timeout). Add &reports=occupancy,past_due to pull a custom subset.
const LIGHT = ['occupancy', 'rent_roll'];

export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const sp = new URL(request.url).searchParams;
    const full = sp.get('full') === '1';
    const custom = (sp.get('reports') || '').split(',').map(s => s.trim()).filter(Boolean);
    const reports = custom.length ? custom : (full ? undefined : LIGHT);  // undefined => all reports
    return NextResponse.json(await runPull({ reports }));
  } catch (e) {
    return NextResponse.json({ status: 'error', message: e.message }, { status: 500 });
  }
}
