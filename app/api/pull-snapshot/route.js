// Vercel cron (or manual hit) triggers the Weekly/Daily/Quarterly Snapshot pull. Mirrors
// app/api/pull/route.js's auth/runtime pattern exactly. Trigger manually via
// `npm run pull:snapshot` until you're ready to schedule it.
import { NextResponse } from 'next/server';
import { runSnapshotPull } from '../../../lib/pullSnapshot.js';

export const runtime = 'nodejs';        // the SOAP client needs the Node runtime, not Edge
export const dynamic = 'force-dynamic';
export const maxDuration = 300;         // needs Vercel Pro — 174 sequential SiteLink calls (3
                                         // periods x 2 reports x 29 sites) won't finish in Hobby's 60s.
                                         // Prefer `npm run pull:snapshot` on Hobby until this is split up.

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
