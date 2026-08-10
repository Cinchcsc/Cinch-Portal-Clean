// Clean JSON read for the KPI page's Occupancy by Floor widget. Mirrors app/api/snapshot/route.js's
// pattern — reads the already-imported unit_floor_status snapshot, no live SiteLink calls here.
import { NextResponse } from 'next/server';
import { getFloorOccupancy } from '../../../lib/floorOccupancy.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Production hardening (27 Jul 2026): this route can paginate across the full unit_floor_status table.
// Keep the Occupancy by Floor widget on real stored data rather than mock fallback when the read is
// merely slow.
export const maxDuration = 300;

const AUTHENTICATED_NO_STORE = 'private, no-store';

function normalizeFloorRow(row) {
  if (!row || typeof row !== 'object') return null;
  const floor = Number(row.floor);
  const totalUnits = Number(row.totalUnits) || 0;
  const occupiedUnits = Number(row.occupiedUnits) || 0;
  const totalArea = Number(row.totalArea) || 0;
  const occupiedArea = Number(row.occupiedArea) || 0;
  return {
    floor: Number.isFinite(floor) ? floor : 0,
    totalUnits,
    occupiedUnits,
    totalArea,
    occupiedArea,
    occPct: totalUnits ? +((occupiedUnits / totalUnits) * 100).toFixed(1) : 0,
  };
}

export async function GET() {
  try {
    const result = await getFloorOccupancy();
    const floors = Array.isArray(result?.floors) ? result.floors.map(normalizeFloorRow).filter(Boolean) : [];
    const sites = Array.isArray(result?.sites) ? result.sites.filter((code) => typeof code === 'string' && code) : [];
    const missing_sites = Array.isArray(result?.missing_sites) ? result.missing_sites.filter((code) => typeof code === 'string' && code) : [];
    const rawSiteFloors = (result?.site_floors && typeof result.site_floors === 'object') ? result.site_floors : {};
    const site_floors = Object.fromEntries(
      Object.entries(rawSiteFloors).map(([code, rows]) => [
        code,
        Array.isArray(rows) ? rows.map(normalizeFloorRow).filter(Boolean) : [],
      ]),
    );
    const complete = !!result?.complete;
    const configured = floors.length > 0;
    return NextResponse.json(
      { configured, generated_at: result?.generated_at || null, sites, floors, site_floors, complete, missing_sites },
      { headers: { 'Cache-Control': AUTHENTICATED_NO_STORE } },
    );
  } catch (error) {
    return NextResponse.json({ configured: false, error: error.message, sites: [], floors: [], site_floors: {}, complete: false, missing_sites: [] }, { status: 500, headers: { 'Cache-Control': AUTHENTICATED_NO_STORE } });
  }
}
