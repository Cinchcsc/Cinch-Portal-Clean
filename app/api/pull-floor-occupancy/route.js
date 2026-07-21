// Vercel cron triggers the floor-level unit snapshot pull that keeps the KPI page's Occupancy by
// Floor widget current. Mirrors the auth/runtime pattern of the other cron routes exactly.
import { NextResponse } from 'next/server';
import { runFloorOccupancyPull } from '../../../lib/pullFloorOccupancy.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    return NextResponse.json(await runFloorOccupancyPull());
  } catch (e) {
    return NextResponse.json({ status: 'error', message: e.message }, { status: 500 });
  }
}
