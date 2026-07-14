// Clean JSON read for Cockpit Charting (District Manager page). Mirrors app/api/snapshot/route.js's
// pattern — reads already-stored data, no live SiteLink calls (those only happen in
// lib/pullCockpit.js via `npm run pull:cockpit` or GET /api/pull-cockpit).
import { NextResponse } from 'next/server';
import { readCockpitData } from '../../../lib/cockpitData.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const data = await readCockpitData();
    const configured = data.curve.length > 0;
    if (!configured) {
      return NextResponse.json(
        { configured: false, month: data.month, curve: [], avgDailyRate: 0 },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
    return NextResponse.json({ configured: true, ...data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ configured: false, error: error.message }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
