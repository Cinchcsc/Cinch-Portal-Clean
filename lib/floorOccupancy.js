// Occupancy by Floor (roadmap #132/#139). Deliberately independent of buildPayload.js's monthly
// pipeline — same separation already used for snapshot_payload/lib/snapshotPayload.js. Floor is a
// static per-unit property (which floor a unit sits on essentially never changes), sourced from a
// manually-exported SiteLink "UnitStatus" report (NOT a callable SOAP method — confirmed against
// the live WSDL) rather than the automated per-month pull. scripts/import-unit-status.js loads
// whatever sites Michael has exported into unit_floor_status; this just reads that table back and
// aggregates by floor. Works with however many sites currently have data (starts at just one —
// L001/Bicester — and grows as more exports are imported), so the widget always reflects real
// imported data rather than needing every site before showing anything.
import { admin } from './supabaseAdmin.js';

async function fetchAllUnitRows() {
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from('unit_floor_status')
      .select('site_code,unit_name,floor,area,rentable,occupied')
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

export async function getFloorOccupancy() {
  const rows = await fetchAllUnitRows();
  const sitesCovered = [...new Set(rows.map((r) => r.site_code))].sort();
  if (!rows.length) return { generated_at: new Date().toISOString(), sites: [], floors: [] };

  // Only rentable units count toward occupancy — a handful of rows in the export are internal/
  // non-rentable ("Company Unit" etc.) and shouldn't be treated as vacant inventory.
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
  const floors = [...byFloor.values()]
    .sort((a, b) => a.floor - b.floor)
    .map((b) => ({ ...b, occPct: b.totalUnits ? +((b.occupiedUnits / b.totalUnits) * 100).toFixed(1) : 0 }));

  return { generated_at: new Date().toISOString(), sites: sitesCovered, floors };
}
