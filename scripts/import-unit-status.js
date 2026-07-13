// Loads a manually-exported SiteLink "UnitStatus" report into unit_floor_status, for the Occupancy
// by Floor widget (roadmap #132/#139). UnitStatus is NOT a callable SOAP method (confirmed against
// the live WSDL) -- only available from SiteLink's own web UI report picker -- so this is a manual,
// per-site import rather than part of the automated pull.js pipeline. Floor is a static per-unit
// property, so re-running this for a site just replaces its rows (upsert on site_code+unit_name);
// there's no "month" to this data.
//
// Expected shape (confirmed 10 Jul 2026 against Michael's export): two sheets.
//   Sheet1: one row per unit. Column P = Floor. Also uses SiteID, UnitName, Type, TenantName,
//     Rentable ('X'/' '), Area.
//   Sheet2: one row per site, maps Sheet1's numeric SiteID to SiteLink's site code (sSiteCode /
//     sLocationCode -- both matched "L001" in the sample file).
// A unit counts as occupied if TenantName is non-blank; a unit counts toward the rentable pool
// (the denominator for occupancy %) only if Rentable === 'X' -- a handful of rows are internal/
// non-rentable ("Company Unit" etc.) and shouldn't be treated as vacant inventory.
//
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/import-unit-status.js <path-to-xlsx>
// Example: node --env-file=.env scripts/import-unit-status.js ~/Downloads/UnitStatus_20260701_20260709_121346.xlsx
import xlsx from 'xlsx';
import { admin } from '../lib/supabaseAdmin.js';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node scripts/import-unit-status.js <path-to-xlsx>');
  process.exit(1);
}

const wb = xlsx.readFile(filePath);
const sheet1 = wb.Sheets[wb.SheetNames[0]];
const sheet2 = wb.Sheets[wb.SheetNames[1]];
if (!sheet1) { console.error(`No sheets found in ${filePath}`); process.exit(1); }

const unitRows = xlsx.utils.sheet_to_json(sheet1, { defval: '' });
const siteRows = sheet2 ? xlsx.utils.sheet_to_json(sheet2, { defval: '' }) : [];

const siteIdToCode = new Map();
for (const s of siteRows) {
  const code = s.sSiteCode || s.sLocationCode;
  if (s.SiteID != null && code) siteIdToCode.set(s.SiteID, String(code).trim());
}
if (!siteIdToCode.size) {
  console.error('Could not map any SiteID -> site code from Sheet2. Aborting -- check the export format hasn\'t changed.');
  process.exit(1);
}
console.log(`Site mapping: ${[...siteIdToCode.entries()].map(([id, code]) => `${id}->${code}`).join(', ')}`);

// FIXED 10 Jul 2026 (pre-go-live audit): Number('') is 0, and Number.isFinite(0) is true, so a
// genuinely BLANK Floor/Area cell was silently stored as 0 rather than null — inflating/skewing the
// Ground Floor occupancy bucket with any unit that simply had no Floor value entered, no error or
// flag raised. Blank/null/undefined now explicitly map to null before the numeric coercion.
const numOrNull = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const records = [];
const unmappedSiteIds = new Set();
for (const r of unitRows) {
  const siteCode = siteIdToCode.get(r.SiteID);
  if (!siteCode) { unmappedSiteIds.add(r.SiteID); continue; }
  const tenantName = String(r.TenantName || '').trim();
  records.push({
    site_code: siteCode,
    unit_name: String(r.UnitName || '').trim(),
    unit_type: String(r.Type || '').trim() || null,
    floor: numOrNull(r.Floor),
    area: numOrNull(r.Area),
    rentable: String(r.Rentable || '').trim() === 'X',
    occupied: tenantName.length > 0,
    imported_at: new Date().toISOString(),
  });
}
if (unmappedSiteIds.size) {
  console.warn(`Skipped ${unitRows.length - records.length} row(s) with unmapped SiteID(s): ${[...unmappedSiteIds].join(', ')}`);
}
if (!records.length) {
  console.error('No usable unit rows found. Aborting.');
  process.exit(1);
}

const bySite = {};
for (const r of records) (bySite[r.site_code] ??= []).push(r);

let ok = 0, failed = 0;
for (const [site, rows] of Object.entries(bySite)) {
  // FIXED 10 Jul 2026 (pre-go-live audit): upsert alone never REMOVES a row — a unit renamed, removed,
  // or corrected between two imports of the same site would linger forever under its old name, still
  // silently counted in that floor's occupancy stats. Each export is a full point-in-time snapshot of
  // ALL of a site's units, so clear the site's existing rows first and re-insert fresh — a clean
  // replace instead of an accumulating merge.
  const { error: delErr } = await admin.from('unit_floor_status').delete().eq('site_code', site);
  if (delErr) { failed += rows.length; console.error(`  ${site}: FAILED to clear existing rows before re-import — ${delErr.message}`); continue; }
  const { error } = await admin.from('unit_floor_status').upsert(rows, { onConflict: 'site_code,unit_name' });
  if (error) { failed += rows.length; console.error(`  ${site}: FAILED — ${error.message}`); }
  else { ok += rows.length; console.log(`  ${site}: upserted ${rows.length} unit rows`); }
}

console.log(`\nDone — ${ok} rows upserted, ${failed} failed.`);
if (ok) {
  const floorCounts = {};
  for (const r of records) { const f = r.floor ?? '?'; floorCounts[f] = (floorCounts[f] || 0) + 1; }
  console.log('Floor breakdown (all sites in this file):', floorCounts);
  const occCount = records.filter((r) => r.rentable && r.occupied).length;
  const rentableCount = records.filter((r) => r.rentable).length;
  console.log(`Rentable units: ${rentableCount}, occupied: ${occCount} (${rentableCount ? ((occCount / rentableCount) * 100).toFixed(1) : 0}%)`);
}
process.exit(failed > 0 && ok === 0 ? 1 : 0);
