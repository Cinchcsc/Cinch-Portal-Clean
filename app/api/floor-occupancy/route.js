// Clean JSON read for the KPI page's Occupancy by Floor widget. Mirrors app/api/snapshot/route.js's
// pattern — reads already-imported data, no live SiteLink calls (UnitStatus isn't a callable SOAP
// method; scripts/import-unit-status.js is the only writer, run manually per exported site).
import { NextResponse } from 'next/server';
import { getFloorOccupancy } from '../../../lib/floorOccupancy.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const result = await getFloorOccupancy();
    return NextResponse.json({ configured: result.floors.length > 0, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ configured: false, error: error.message, sites: [], floors: [], site_floors: {} }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
