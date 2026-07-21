// Floor Occupancy / Unit Status auto-update (21 Jul 2026 follow-up). Pulls floor-level unit data
// from CallCenterWs.UnitsInformation into unit_floor_status so the KPI page's Occupancy by Floor
// widget stays current without a separate manual import. One UnitsInformation call per site, using
// the same shared overlap guard as every other SiteLink job because the account still rejects
// concurrent logons (-99).
//
// Run manually: npm run pull:floor-occupancy
// Or via HTTP: GET /api/pull-floor-occupancy (scheduled daily via vercel.json).
import { admin } from './supabaseAdmin.js';
import { callCallCenterMethod } from './sitelink.js';
import { checkPullLock, startPullLog, finishPullLog } from './pullLock.js';
import { describeError } from './describeError.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bool = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? '').trim());
const numOrNull = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const areaFromRow = (r) => {
  const width = numOrNull(r.dcWidth);
  const length = numOrNull(r.dcLength);
  if (width == null || length == null) return null;
  return +(width * length).toFixed(2);
};

async function tryUnitsInformation(locationCode) {
  const backoff = [0, 2000, 5000];
  for (let attempt = 1; ; attempt++) {
    try { return await callCallCenterMethod('UnitsInformation', locationCode); }
    catch (e) { if (attempt >= backoff.length) throw e; await sleep(backoff[attempt]); }
  }
}

function rowsToRecords(rows, locationCode) {
  return rows
    .map((r) => ({
      site_code: String(r.sLocationCode || locationCode).trim(),
      unit_name: String(r.sUnitName || '').trim(),
      unit_type: String(r.sTypeName || '').trim() || null,
      floor: numOrNull(r.iFloor),
      area: areaFromRow(r),
      rentable: bool(r.bRentable),
      occupied: bool(r.bRented),
      imported_at: new Date().toISOString(),
    }))
    .filter((r) => r.site_code && r.unit_name);
}

export async function runFloorOccupancyPull({ locations = (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean) } = {}) {
  const lock = await checkPullLock();
  if (lock.locked) { console.error('[pull-floor-occupancy] ' + lock.message); return { status: 'skipped', message: lock.message }; }

  const started = Date.now();
  const logId = await startPullLog('floor');
  if (!locations.length) {
    await finishPullLog(logId, 'error', 'SITELINK_LOCATIONS not set');
    throw new Error('SITELINK_LOCATIONS not set');
  }

  try {
    console.error(`[pull-floor-occupancy] ${locations.length} sites — UnitsInformation per site...`);
    let okSites = 0, failedSites = 0, okRows = 0, failedRows = 0;
    const errors = [];

    for (const locationCode of locations) {
      try {
        const { rows } = await tryUnitsInformation(locationCode);
        if (!rows.length) throw new Error('no rows returned');
        const records = rowsToRecords(rows, locationCode);
        if (!records.length) throw new Error('rows returned, but none had usable site/unit identifiers');

        const { error: delErr } = await admin.from('unit_floor_status').delete().eq('site_code', records[0].site_code);
        if (delErr) throw new Error(`clear existing rows failed: ${delErr.message}`);

        const { error } = await admin.from('unit_floor_status').upsert(records, { onConflict: 'site_code,unit_name' });
        if (error) throw new Error(`upsert failed: ${error.message}`);

        okSites += 1;
        okRows += records.length;
        const rentable = records.filter((r) => r.rentable).length;
        const occupied = records.filter((r) => r.rentable && r.occupied).length;
        console.error(`  ${locationCode}: imported ${records.length} units (${rentable} rentable, ${occupied} occupied)`);
      } catch (e) {
        failedSites += 1;
        const msg = describeError(e);
        console.error(`  ${locationCode}: FAILED — ${msg}`);
        errors.push(`${locationCode}: ${msg}`);
      }
    }

    const status = failedSites > okSites ? 'error' : (failedSites ? 'partial' : 'ok');
    const detail = `${okSites}/${locations.length} sites imported, ${okRows} rows written, ${failedRows} rows failed`
      + (errors.length ? ' | ' + errors.slice(0, 10).join(' | ') : '');
    await finishPullLog(logId, status, detail);
    return { status, durationMs: Date.now() - started, sites: locations.length, okSites, failedSites, okRows, failedRows, errors: errors.slice(0, 10) };
  } catch (e) {
    await finishPullLog(logId, 'error', describeError(e));
    throw e;
  }
}
