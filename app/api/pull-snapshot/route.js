// Vercel cron (see vercel.json, scheduled 0 6 * * * — its own hour, same reasoning as every other
// cron entry there) triggers the Weekly/Daily/Quarterly Snapshot pull. Mirrors app/api/pull/route.js's
// auth/runtime pattern exactly. Can still be run manually any time via `npm run pull:snapshot`.
import { NextResponse } from 'next/server';
import { runSnapshotPull } from '../../../lib/pullSnapshot.js';

export const runtime = 'nodejs';        // the SOAP client needs the Node runtime, not Edge
export const dynamic = 'force-dynamic';
// CHECKED 14 Jul 2026 (Michael confirmed Hobby plan): 300s is Hobby's default+max duration too, via
// Vercel's now-default-on Fluid Compute — NOT Pro-only, contrary to this comment's old assumption.
// 174 sequential SiteLink calls (3 periods x 2 reports x 29 sites) needs the full 300s regardless of
// plan; that part is unchanged.
export const maxDuration = 300;

export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    return NextResponse.json(await runSnapshotPull());
  } catch (e) {
    return NextResponse.json({ status: 'error', message: e.message }, { status: 500 });
  }
}
