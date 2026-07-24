// Occupancy by Floor (roadmap #132/#139). Deliberately independent of buildPayload.js's monthly
// pipeline — same separation already used for snapshot_payload/lib/snapshotPayload.js. Floor is a
// static per-unit property (which floor a unit sits on essentially never changes). unit_floor_status
// can now be fed either by the older manual UnitStatus XLSX import or, preferably, by the live
// CallCenterWs UnitsInformation API import added on 21 Jul 2026 (confirmed live to return iFloor,
// bRented, bRentable, and unit dimensions). This reader stays agnostic about which importer wrote
// the rows; it just aggregates whatever sites are currently loaded, so the widget always reflects
// real imported data rather than needing every site before showing anything.
import { admin } from './supabaseAdmin.js';

async function fetchAllUnitRows() {
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from('unit_floor_status')
      .select('site_code,unit_name,floor,area,rentable,occupied,imported_at')
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

function aggregateFloors(rows) {
  const rentableRows = rows.filter((r) => r.rentable);
  const byFloor = new Map();
  for (const r of rentableRows) {
    const f = r.floor ?? 0;
    if (!byFloor.has(f)) byFloor.set(f, { floor: f, totalUnits: 0, occupiedUnits: 0, totalArea: 0, occupiedArea: 0 });
    const b = byFloor.get(f);
    b.totalUnits += 1;
    b.totalArea += r.area || 0;
    if (r.occupied) { b.occupiedUnits += 1; b.occupiedArea += r.area || 0; }
  }
  return [...byFloor.values()]
    .sort((a, b) => a.floor - b.floor)
    .map((b) => ({ ...b, occPct: b.totalUnits ? +((b.occupiedUnits / b.totalUnits) * 100).toFixed(1) : 0 }));
}

export async function getFloorOccupancy() {
  const rows = await fetchAllUnitRows();
  const sitesCovered = [...new Set(rows.map((r) => r.site_code))].sort();
  const generatedAt = rows.reduce((latest, r) => {
    const ts = r.imported_at ? new Date(r.imported_at).getTime() : 0;
    return ts > latest ? ts : latest;
  }, 0);
  if (!rows.length) return { generated_at: null, sites: [], floors: [], site_floors: {} };

  // Only rentable units count toward occupancy — a handful of rows in the import are internal/
  // non-rentable ("Company Unit" etc.) and shouldn't be treated as vacant inventory. Return BOTH
  // the whole-book rollup and a per-site breakdown so the KPI page's existing multi-store selector
  // can recompute "Occupancy by Floor" client-side for any subset of sites without another API hop.
  const siteFloors = {};
  for (const site of sitesCovered) {
    const siteRows = rows.filter((r) => r.site_code === site);
    siteFloors[site] = aggregateFloors(siteRows);
  }
  const floors = aggregateFloors(rows);

  return { generated_at: generatedAt ? new Date(generatedAt).toISOString() : null, sites: sitesCovered, floors, site_floors: siteFloors };
}
