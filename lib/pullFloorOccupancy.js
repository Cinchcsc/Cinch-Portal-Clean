// Floor Occupancy / Unit Status auto-update (21 Jul 2026 follow-up). Pulls floor-level unit data
// from CallCenterWs.UnitsInformation into unit_floor_status so the KPI page's Occupancy by Floor
// widget stays current without a separate manual import. One UnitsInformation call per site, using
// the same shared overlap guard as every other SiteLink job because the account still rejects
// concurrent logons (-99).
//
// Run manually: npm run pull:floor-occupancy
// Or via HTTP: GET /api/pull-floor-occupancy (scheduled daily via vercel.json).
import { admin } from './supabaseAdmin.js';
import { callCallCenterMethod, extractRowsWithKey } from './sitelink.js';
import { STALE_MS, checkPullLock, startPullLogLenient, finishPullLog, recordCompletedPullLog } from './pullLock.js';
import { describeError } from './describeError.js';
import { retryOnStatementTimeout } from './supabaseRetry.js';

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

async function waitForUnlocked(maxWaitMs = 4 * 60 * 1000, pollMs = 15 * 1000) {
  const started = Date.now();
  let lastMessage = null;
  for (;;) {
    const lock = await checkPullLock({ activeKinds: ['pull', 'cockpit', 'floor'] });
    if (!lock.locked) return { ok: true };
    lastMessage = lock.message || 'Another refresh job is still running.';
    const waitedMs = Date.now() - started;
    const remainingBudgetMs = maxWaitMs - waitedMs;
    const staleRemainingMs = typeof lock.ageMs === 'number'
      ? Math.max(0, (lock.staleMs || STALE_MS) - lock.ageMs)
      : null;
    const nextWaitMs = staleRemainingMs == null
      ? pollMs
      : Math.min(pollMs, Math.max(1000, staleRemainingMs + 1000));
    if (remainingBudgetMs < nextWaitMs) return { ok: false, message: lastMessage };
    console.error(`[pull-floor-occupancy] lock still held — waiting ${Math.round(nextWaitMs / 1000)}s before retrying...`);
    await new Promise((res) => setTimeout(res, nextWaitMs));
  }
}

async function tryUnitsInformation(locationCode) {
  const backoff = [0, 2000, 5000];
  for (let attempt = 1; ; attempt++) {
    try {
      // Prefer the richer v3 response when available: it can surface a slightly more complete unit
      // universe for some sites (for example L003/Letchworth on 4 Aug 2026), while the older
      // UnitsInformation method remains a safe fallback for locations/accounts that do not expose v3.
      const { raw } = await callCallCenterMethod('UnitsInformation_v3', locationCode, {
        lngLastTimePolled: '0',
        bReturnExcludedFromWebsiteUnits: true,
      }).catch(() => callCallCenterMethod('UnitsInformation', locationCode));
      // FIXED 22 Jul 2026 (task #400, L028/Edmonton missing from the pull) — don't trust the generic
      // `rows` callCallCenterMethod returns. UnitsInformation's diffgram also contains a fixed ~72-row
      // unit-attributes lookup table (Lighted/Wine/Climate Controlled/...), and extractRows()'s
      // "biggest array wins" heuristic picks THAT instead of the real per-unit rows for any site with
      // fewer than ~72 actual units — confirmed live for L028. Re-extract from `raw` by row shape
      // instead (must actually carry sUnitName) — see extractRowsWithKey()'s own comment in
      // lib/sitelink.js for the full diagnosis.
      return { rows: extractRowsWithKey(raw, 'sUnitName') };
    }
    catch (e) { if (attempt >= backoff.length) throw e; await sleep(backoff[attempt]); }
  }
}

function rowsToRecords(rows, locationCode, importedAt) {
  return rows
    .map((r) => ({
      site_code: String(r.sLocationCode || locationCode).trim(),
      unit_name: String(r.sUnitName || '').trim(),
      unit_type: String(r.sTypeName || '').trim() || null,
      floor: numOrNull(r.iFloor),
      area: areaFromRow(r),
      rentable: bool(r.bRentable),
      occupied: bool(r.bRented),
      imported_at: importedAt,
    }))
    .filter((r) => r.site_code && r.unit_name);
}

export async function runFloorOccupancyPull({ locations = (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean), triggerLabel = null, skipLockCheck = false } = {}) {
  const started = Date.now();
  const startedAtIso = new Date(started).toISOString();
  if (!skipLockCheck) {
    const unlocked = await waitForUnlocked();
    if (!unlocked.ok) {
      const blockedLogId = await startPullLogLenient('floor', 'floor occupancy skip');
      console.error('[pull-floor-occupancy] ' + unlocked.message);
      if (blockedLogId) await finishPullLog(blockedLogId, 'skipped', unlocked.message);
      else await recordCompletedPullLog('floor', 'skipped', unlocked.message, startedAtIso);
      return { status: 'skipped', message: unlocked.message };
    }
  }
  const logId = await startPullLogLenient('floor', 'floor occupancy');
  const finishOrBackfillLog = async (status, detail) => {
    if (logId) return finishPullLog(logId, status, detail);
    return recordCompletedPullLog('floor', status, detail, startedAtIso);
  };
  if (!skipLockCheck) {
    const claimedLock = await checkPullLock({ activeKinds: ['pull', 'cockpit', 'floor'], claimingLogId: logId });
    if (claimedLock.locked) {
      console.error('[pull-floor-occupancy] ' + claimedLock.message);
      await finishOrBackfillLog('skipped', claimedLock.message);
      return { status: 'skipped', message: claimedLock.message };
    }
  }
  if (!locations.length) {
    await finishOrBackfillLog('error', 'SITELINK_LOCATIONS not set');
    throw new Error('SITELINK_LOCATIONS not set');
  }

  try {
    console.error(`[pull-floor-occupancy] ${locations.length} sites — UnitsInformation per site...`);
    let okSites = 0, failedSites = 0, okRows = 0;
    const errors = [];

    for (const locationCode of locations) {
      try {
        const { rows } = await tryUnitsInformation(locationCode);
        if (!rows.length) throw new Error('no rows returned');
        const importedAt = new Date().toISOString();
        const records = rowsToRecords(rows, locationCode, importedAt);
        if (!records.length) throw new Error('rows returned, but none had usable site/unit identifiers');

        const { error } = await retryOnStatementTimeout(async () => admin.from('unit_floor_status').upsert(records, { onConflict: 'site_code,unit_name' }));
        if (error) throw new Error(`upsert failed: ${error.message}`);
        // Fail-safe refresh (28 Jul 2026 production audit): this used to DELETE the site's existing
        // snapshot before writing the replacement rows. Any transient DB/network error between those
        // two calls left the site with zero floor data until the next successful refresh. Upsert the
        // new snapshot first, stamp every refreshed row with one shared imported_at, then prune only
        // rows older than this successful batch. That preserves the prior snapshot if today's write
        // fails, while still removing units that genuinely disappeared from the latest export.
        const { error: pruneErr } = await retryOnStatementTimeout(async () => admin
          .from('unit_floor_status')
          .delete()
          .eq('site_code', records[0].site_code)
          .lt('imported_at', importedAt));
        if (pruneErr) throw new Error(`stale-row prune failed: ${pruneErr.message}`);

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
    const detail = [
      triggerLabel ? `trigger=${triggerLabel}` : null,
      `${okSites}/${locations.length} sites imported, ${okRows} rows written, ${failedSites} sites failed`,
      errors.length ? errors.slice(0, 10).join(' | ') : null,
    ].filter(Boolean).join(' | ');
    await finishOrBackfillLog(status, detail);
    return { status, durationMs: Date.now() - started, sites: locations.length, okSites, failedSites, okRows, errors: errors.slice(0, 10) };
  } catch (e) {
    await finishOrBackfillLog('error', describeError(e));
    throw e;
  }
}
