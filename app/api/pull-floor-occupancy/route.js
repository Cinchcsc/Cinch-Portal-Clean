// Vercel cron (see vercel.json, scheduled 0 13 * * * UTC) triggers the floor-level unit snapshot
// pull that keeps the KPI page's Occupancy by Floor widget current. Mirrors the auth/runtime pattern
// of the other cron routes exactly.
import { NextResponse } from 'next/server';
import { runFloorOccupancyPull } from '../../../lib/pullFloorOccupancy.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
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
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const u = new URL(request.url);
    const result = await runFloorOccupancyPull({ triggerLabel: `${u.pathname}${u.search || ''} ua=${(request.headers.get('user-agent') || 'unknown').replace(/\s+/g, ' ').trim()}` });
    return NextResponse.json(result, { status: statusCodeForJob(result) });
  } catch (e) {
    return NextResponse.json({ status: 'error', message: e.message }, { status: 500 });
  }
}
