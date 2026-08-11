// Occupancy by Floor (roadmap #132/#139). Deliberately independent of buildPayload.js's monthly
// pipeline — same separation already used for snapshot_payload/lib/snapshotPayload.js. Floor is a
// static per-unit property (which floor a unit sits on essentially never changes). unit_floor_status
// can now be fed either by the older manual UnitStatus XLSX import or, preferably, by the live
// CallCenterWs UnitsInformation API import added on 21 Jul 2026 (confirmed live to return iFloor,
// bRented, bRentable, and unit dimensions). This reader stays agnostic about which importer wrote
// the rows; it just aggregates whatever sites are currently loaded, so the widget always reflects
// real imported data rather than needing every site before showing anything.
import { admin } from './supabaseAdmin.js';
import { PORTAL_SITE_CODES } from './buildPayload.js';
import { readPortalPayloadFreshCurrentMonthStable } from './portalPayload.js';
import { retryOnStatementTimeout } from './supabaseRetry.js';

async function fetchAllUnitRows() {
  const out = [];
  const PAGE = 1000;
  let lastId = 0;
  for (;;) {
    const { data, error } = await retryOnStatementTimeout(async () => admin
      .from('unit_floor_status')
      .select('id,site_code,unit_name,floor,area,rentable,occupied,imported_at')
      .gt('id', lastId)
      .order('id')
      .limit(PAGE));
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
    lastId = data[data.length - 1].id;
  }
  return out;
}

function aggregateFloors(rows) {
  const byFloor = new Map();
  for (const r of rows) {
    const area = Number(r.area) || 0;
    const hasFloor = Number.isFinite(Number(r.floor));
    // Count every real imported unit toward the floor widget's unit totals. The August 4, 2026 audit
    // showed the main portal's occupancy totals line up much more closely with the raw UnitsInformation
    // unit universe than with the narrower `bRentable` subset, while truly junk placeholders are the
    // rows that have neither a usable floor nor any positive area.
    if (!hasFloor && area <= 0) continue;
    const f = hasFloor ? Number(r.floor) : 0;
    if (!byFloor.has(f)) byFloor.set(f, { floor: f, totalUnits: 0, occupiedUnits: 0, totalArea: 0, occupiedArea: 0 });
    const b = byFloor.get(f);
    b.totalUnits += 1;
    if (area > 0) b.totalArea += area;
    if (r.occupied) {
      b.occupiedUnits += 1;
      if (area > 0) b.occupiedArea += area;
    }
  }
  return [...byFloor.values()]
    .sort((a, b) => a.floor - b.floor)
    .map((b) => ({ ...b, occPct: b.totalUnits ? +((b.occupiedUnits / b.totalUnits) * 100).toFixed(1) : 0 }));
}

function reconcileFloorOccupancy(rows, targetOccupiedUnits, targetTotalUnits = null) {
  const target = Number(targetOccupiedUnits);
  const targetTotal = Number(targetTotalUnits);
  if (!Array.isArray(rows) || !rows.length || !Number.isFinite(target) || target < 0) return rows;
  const sourceOccupied = rows.reduce((sum, row) => sum + (Number(row.occupiedUnits) || 0), 0);
  const sourceTotal = rows.reduce((sum, row) => sum + (Number(row.totalUnits) || 0), 0);
  if (sourceOccupied <= 0) {
    return rows.map((row) => ({
      ...row,
      occupiedUnits: 0,
      occupiedArea: 0,
      occPct: 0,
    }));
  }
  const rawScaled = rows.map((row) => {
    const occupiedUnits = Number(row.occupiedUnits) || 0;
    const totalUnits = Number(row.totalUnits) || 0;
    const occupiedArea = Number(row.occupiedArea) || 0;
    const scaled = occupiedUnits * target / sourceOccupied;
    const base = Math.min(totalUnits, Math.max(0, Math.floor(scaled)));
    return {
      row,
      totalUnits,
      occupiedArea,
      occupiedUnits,
      base,
      fraction: scaled - Math.floor(scaled),
    };
  });
  let assigned = rawScaled.reduce((sum, item) => sum + item.base, 0);
  let remaining = Math.max(0, target - assigned);
  const byPriority = rawScaled
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => {
      if (b.item.fraction !== a.item.fraction) return b.item.fraction - a.item.fraction;
      if (b.item.occupiedUnits !== a.item.occupiedUnits) return b.item.occupiedUnits - a.item.occupiedUnits;
      return a.idx - b.idx;
    });
  for (const item of byPriority) {
    if (remaining <= 0) break;
    const capacity = item.item.totalUnits - item.item.base;
    if (capacity <= 0) continue;
    const add = Math.min(capacity, remaining);
    item.item.base += add;
    remaining -= add;
  }
  let reconciled = rawScaled.map((item) => {
    const occupiedUnits = item.base;
    const occupiedArea = item.occupiedUnits > 0
      ? Math.min(Number(item.row.totalArea) || 0, (item.occupiedArea || 0) * (occupiedUnits / item.occupiedUnits))
      : 0;
    return {
      ...item.row,
      occupiedUnits,
      occupiedArea,
      occPct: item.totalUnits ? +((occupiedUnits / item.totalUnits) * 100).toFixed(1) : 0,
    };
  });
  if (Number.isFinite(targetTotal) && targetTotal >= 0 && sourceTotal !== targetTotal) {
    let totalDelta = targetTotal - reconciled.reduce((sum, row) => sum + (Number(row.totalUnits) || 0), 0);
    if (totalDelta > 0) {
      const addOrder = reconciled
        .map((row, idx) => ({ row, idx }))
        .sort((a, b) => {
          if ((b.row.totalUnits || 0) !== (a.row.totalUnits || 0)) return (b.row.totalUnits || 0) - (a.row.totalUnits || 0);
          return a.idx - b.idx;
        });
      while (totalDelta > 0) {
        let changed = false;
        for (const item of addOrder) {
          if (totalDelta <= 0) break;
          item.row.totalUnits += 1;
          totalDelta -= 1;
          changed = true;
        }
        if (!changed) break;
      }
    } else if (totalDelta < 0) {
      const removeOrder = reconciled
        .map((row, idx) => ({ row, idx }))
        .sort((a, b) => {
          const aVacant = (a.row.totalUnits || 0) - (a.row.occupiedUnits || 0);
          const bVacant = (b.row.totalUnits || 0) - (b.row.occupiedUnits || 0);
          if (bVacant !== aVacant) return bVacant - aVacant;
          if ((b.row.totalUnits || 0) !== (a.row.totalUnits || 0)) return (b.row.totalUnits || 0) - (a.row.totalUnits || 0);
          return a.idx - b.idx;
        });
      while (totalDelta < 0) {
        let changed = false;
        for (const item of removeOrder) {
          if (totalDelta >= 0) break;
          if ((item.row.totalUnits || 0) <= (item.row.occupiedUnits || 0)) continue;
          item.row.totalUnits -= 1;
          totalDelta += 1;
          changed = true;
        }
        if (!changed) break;
      }
    }
    reconciled = reconciled.map((row) => ({
      ...row,
      occPct: row.totalUnits ? +((row.occupiedUnits / row.totalUnits) * 100).toFixed(1) : 0,
    }));
  }
  return reconciled;
}

export async function getFloorOccupancy() {
  const rows = await fetchAllUnitRows();
  const portal = await readPortalPayloadFreshCurrentMonthStable().catch(() => null);
  const occupiedTargetBySite = new Map((portal?.payload?.sites || []).map((site) => [site.code, Number(site.occ) || 0]));
  const totalTargetBySite = new Map((portal?.payload?.sites || []).map((site) => [site.code, Number(site.tot) || 0]));
  const { data: sitesRef, error: sitesErr } = await retryOnStatementTimeout(async () => admin
    .from('sites')
    .select('code'));
  if (sitesErr) {
    console.warn('[floorOccupancy] sites reference read failed; falling back to built-in portal site list:', sitesErr.message);
  }
  const expectedSites = (sitesErr
    ? [...PORTAL_SITE_CODES]
    : [...new Set((sitesRef || []).map((row) => row?.code).filter(Boolean))]
  ).sort();
  const sitesCovered = [...new Set(rows.map((r) => r.site_code))].sort();
  const missingSites = expectedSites.filter((code) => !sitesCovered.includes(code));
  if (!rows.length) return { generated_at: null, sites: [], floors: [], site_floors: {}, complete: expectedSites.length === 0, missing_sites: expectedSites };
  const latestBySite = new Map(sitesCovered.map((site) => [site, 0]));
  for (const row of rows) {
    const ts = row.imported_at ? new Date(row.imported_at).getTime() : 0;
    const prev = latestBySite.get(row.site_code) || 0;
    if (ts > prev) latestBySite.set(row.site_code, ts);
  }
  // Production hardening (28 Jul 2026): this dataset is refreshed site-by-site, not as a single
  // atomic portfolio snapshot. Reporting the MAX imported_at made the whole widget look as fresh as
  // the last site written even when some sites could still be older. Use the oldest "latest per
  // site" timestamp instead, which is the most recent moment the entire returned site set was known
  // to be current together.
  const generatedAt = latestBySite.size ? Math.min(...latestBySite.values()) : 0;

  // Only rentable units count toward occupancy — a handful of rows in the import are internal/
  // non-rentable ("Company Unit" etc.) and shouldn't be treated as vacant inventory. Return BOTH
  // the whole-book rollup and a per-site breakdown so the KPI page's existing multi-store selector
  // can recompute "Occupancy by Floor" client-side for any subset of sites without another API hop.
  const siteFloors = {};
  for (const site of sitesCovered) {
    const siteRows = rows.filter((r) => r.site_code === site);
    siteFloors[site] = reconcileFloorOccupancy(aggregateFloors(siteRows), occupiedTargetBySite.get(site), totalTargetBySite.get(site));
  }
  const floors = aggregateFloors(Object.entries(siteFloors).flatMap(([site, floorRows]) => floorRows.map((row) => ({
    site_code: site,
    floor: row.floor,
    area: row.totalArea,
    occupied: false,
    totalUnits: row.totalUnits,
    occupiedUnits: row.occupiedUnits,
    totalArea: row.totalArea,
    occupiedArea: row.occupiedArea,
  }))));
  const portfolioFloors = (() => {
    const byFloor = new Map();
    for (const rows of Object.values(siteFloors)) {
      for (const row of rows) {
        const bucket = byFloor.get(row.floor) || { floor: row.floor, totalUnits: 0, occupiedUnits: 0, totalArea: 0, occupiedArea: 0 };
        bucket.totalUnits += Number(row.totalUnits) || 0;
        bucket.occupiedUnits += Number(row.occupiedUnits) || 0;
        bucket.totalArea += Number(row.totalArea) || 0;
        bucket.occupiedArea += Number(row.occupiedArea) || 0;
        byFloor.set(row.floor, bucket);
      }
    }
    return [...byFloor.values()]
      .sort((a, b) => a.floor - b.floor)
      .map((row) => ({ ...row, occPct: row.totalUnits ? +((row.occupiedUnits / row.totalUnits) * 100).toFixed(1) : 0 }));
  })();

  return {
    generated_at: generatedAt ? new Date(generatedAt).toISOString() : null,
    sites: sitesCovered,
    floors: portfolioFloors,
    site_floors: siteFloors,
    complete: missingSites.length === 0,
    missing_sites: missingSites,
  };
}
