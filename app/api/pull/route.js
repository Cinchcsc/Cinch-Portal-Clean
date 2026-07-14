// Vercel cron hits this route (see vercel.json). Vercel sends Authorization: Bearer $CRON_SECRET.
// Lives at /api/pull in the Next.js app.
import { NextResponse } from 'next/server';
import { runPull } from '../../../lib/pull.js';

export const runtime = 'nodejs';        // the SOAP client needs the Node runtime, not Edge
export const dynamic = 'force-dynamic';
// CHECKED 14 Jul 2026 (Michael confirmed Hobby plan): maxDuration up to 300s is fine on Hobby too —
// Vercel's Fluid Compute is enabled by default on every plan now (confirmed live against Vercel's own
// current docs), so 300s is Hobby's default AND max, not a Pro-only feature. The real Hobby constraint
// is cron SCHEDULING, not function duration: crons on Hobby only fire once/day and Vercel doesn't
// guarantee the exact minute — it can trigger anywhere in the scheduled HOUR (confirmed via
// vercel.com/docs/cron-jobs/usage-and-pricing). See vercel.json's comment for why every cron entry
// now gets its OWN hour instead of being packed 10 minutes apart within one hour.
export const maxDuration = 300;

// COST CONTROL: the full 17-report pull is ~500 SiteLink calls and won't finish inside a single 60s
// window even with 300s available split across multiple cron hits. So the daily cron runs a LIGHT set
// (occupancy + rent_roll, ~58 calls) to keep occupancy/rates fresh; the heavier flow reports
// (insurance, marketing, financials, debtors, …) run via the other 4 scheduled ?reports=... hits in
// vercel.json (each its own hour), or with ?full=1 for an ad-hoc all-reports pull (best on the Mac via
// `npm run pull`, no timeout). Add &reports=occupancy,past_due to pull any custom subset.
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
