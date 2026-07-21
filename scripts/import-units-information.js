// Imports floor-level unit data into unit_floor_status directly from SiteLink's CallCenterWs
// UnitsInformation method. Confirmed live on 21 Jul 2026 against L001: the response includes iFloor,
// bRented, bRentable, sUnitName, sTypeName, sLocationCode, and dimensions (dcWidth/dcLength) from
// which we can derive area. This is now the PREFERRED path for Occupancy by Floor; the older XLSX
// UnitStatus import remains as a fallback for any site/account where this API path misbehaves.
//
// Usage:
//   node --env-file=.env scripts/import-units-information.js               # all SITELINK_LOCATIONS
//   node --env-file=.env scripts/import-units-information.js L001,L004     # explicit sites
import { callCallCenterMethod } from '../lib/sitelink.js';
import { admin } from '../lib/supabaseAdmin.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) {
  console.error('Missing env:', miss.join(', '));
  process.exit(1);
}

const locations = (process.argv[2] || process.env.SITELINK_LOCATIONS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (!locations.length) {
  console.error('Usage: node --env-file=.env scripts/import-units-information.js <LOCATION[,LOCATION2,...]>');
  console.error('No locations provided and SITELINK_LOCATIONS is blank.');
  process.exit(1);
}

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

let okSites = 0, failedSites = 0, okRows = 0, failedRows = 0;

for (const locationCode of locations) {
  try {
    const { rows } = await callCallCenterMethod('UnitsInformation', locationCode);
    if (!rows.length) {
      failedSites += 1;
      console.error(`${locationCode}: no rows returned`);
      continue;
    }

    const records = rows
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

    if (!records.length) {
      failedSites += 1;
      console.error(`${locationCode}: rows returned, but none had usable site/unit identifiers`);
      continue;
    }

    const { error: delErr } = await admin.from('unit_floor_status').delete().eq('site_code', records[0].site_code);
    if (delErr) {
      failedSites += 1;
      failedRows += records.length;
      console.error(`${locationCode}: FAILED to clear existing rows — ${delErr.message}`);
      continue;
    }

    const { error } = await admin.from('unit_floor_status').upsert(records, { onConflict: 'site_code,unit_name' });
    if (error) {
      failedSites += 1;
      failedRows += records.length;
      console.error(`${locationCode}: FAILED — ${error.message}`);
      continue;
    }

    okSites += 1;
    okRows += records.length;
    const rentable = records.filter((r) => r.rentable).length;
    const occupied = records.filter((r) => r.rentable && r.occupied).length;
    const floors = [...new Set(records.map((r) => r.floor).filter((v) => v != null))].sort((a, b) => a - b);
    console.log(`${locationCode}: imported ${records.length} units (${rentable} rentable, ${occupied} occupied, floors: ${floors.join(', ') || 'none'})`);
  } catch (e) {
    failedSites += 1;
    console.error(`${locationCode}: FAILED — ${e.message}`);
  }
}

console.log(`\nDone — ${okSites}/${locations.length} site(s) imported, ${okRows} rows written, ${failedRows} rows failed.`);
process.exit(okSites > 0 ? 0 : 1);
