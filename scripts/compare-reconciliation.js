// Read-only helper: compares the latest exported reconciliation-data.json against the workbook
// Michael is using for store-by-store parallel-run validation. This does NOT call SiteLink or
// Supabase; it only reads local artifacts, so it's safe to run even while the DB is flaky.
//
// Usage:
//   node scripts/compare-reconciliation.js
//   node scripts/compare-reconciliation.js "../store_by_store_reconciliation - refreshed 20 Jul.xlsx"
import { readFileSync } from 'fs';
import path from 'path';
import XLSX from 'xlsx';

const workbookArg = process.argv[2] || '../store_by_store_reconciliation - refreshed 20 Jul.xlsx';
const workbookPath = path.resolve(process.cwd(), workbookArg);
const exportPath = path.resolve(process.cwd(), '../reconciliation-data.json');

const exportJson = JSON.parse(readFileSync(exportPath, 'utf8'));
const oursByStore = new Map((exportJson.sites || []).map((row) => [row.name, row]));

const wb = XLSX.readFile(workbookPath, { cellDates: false });

function readSheet(name) {
  const sheet = wb.Sheets[name];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet, { defval: null });
}

function num(v) {
  return typeof v === 'number' ? v : (v == null || v === 'n/a' ? null : Number(v));
}

function printSection(title, rows) {
  console.log(`\n${title}`);
  if (!rows.length) {
    console.log('  none');
    return;
  }
  for (const row of rows) console.log(`  ${row}`);
}

const occupancyDiffs = [];
for (const row of readSheet('Occupancy')) {
  const store = row.Store;
  if (!store || String(store).startsWith('TOTAL')) continue;
  const ours = oursByStore.get(store);
  if (!ours) continue;
  const legacyOcc = num(row['Legacy: Occupied']);
  const legacyTot = num(row['Legacy: Total']);
  if (legacyOcc == null || legacyTot == null) continue;
  const dOcc = (ours.occ ?? 0) - legacyOcc;
  const dTot = (ours.tot ?? 0) - legacyTot;
  if (dOcc || dTot) occupancyDiffs.push(`${store}: occupied ${ours.occ} vs ${legacyOcc} (${dOcc >= 0 ? '+' : ''}${dOcc}), total ${ours.tot} vs ${legacyTot} (${dTot >= 0 ? '+' : ''}${dTot})`);
}

const insuranceDiffs = [];
for (const row of readSheet('Insurance Roll')) {
  const store = row.Store;
  if (!store || String(store).startsWith('TOTAL')) continue;
  const ours = oursByStore.get(store);
  if (!ours) continue;
  const legacyPremium = num(row['Legacy: Premiums']);
  const legacyPctInsured = num(row['Legacy: %Insured']);
  if (legacyPremium == null || legacyPctInsured == null) continue;
  const ourPremiumRounded = Math.round(ours.insurancePremium ?? 0);
  const ourPctInsured = Number(ours.insurancePenetrationPC ?? 0) / 100;
  const dPremium = ourPremiumRounded - legacyPremium;
  const dPct = +(ourPctInsured - legacyPctInsured).toFixed(3);
  if (dPremium || dPct) insuranceDiffs.push(`${store}: premiums ${ourPremiumRounded} vs ${legacyPremium} (${dPremium >= 0 ? '+' : ''}${dPremium}), % insured ${ourPctInsured.toFixed(3)} vs ${legacyPctInsured.toFixed(3)} (${dPct >= 0 ? '+' : ''}${dPct.toFixed(3)})`);
}

const enquiriesDiffs = [];
for (const row of readSheet('Enquiries and Reservations')) {
  const store = row.Store;
  if (!store || String(store).startsWith('TOTAL')) continue;
  const ours = oursByStore.get(store);
  if (!ours) continue;
  const legacyEnquiries = num(row['Legacy: Enquiries']);
  if (legacyEnquiries == null) continue;
  const dEnquiries = (ours.enquiriesTotal ?? 0) - legacyEnquiries;
  if (dEnquiries) {
    const reservationsMade = Object.prototype.hasOwnProperty.call(ours, 'reservationsMade') ? ours.reservationsMade : 'n/a';
    const reservationConversions = Object.prototype.hasOwnProperty.call(ours, 'reservationConversions') ? ours.reservationConversions : 'n/a';
    enquiriesDiffs.push(`${store}: enquiries ${ours.enquiriesTotal} vs ${legacyEnquiries} (${dEnquiries >= 0 ? '+' : ''}${dEnquiries}), reservationsMade ${reservationsMade}, reservationConversions ${reservationConversions}`);
  }
}

console.log(`Workbook: ${workbookPath}`);
console.log(`Export: ${exportPath}`);
console.log(`Exported at: ${exportJson.exported_at || 'unknown'} | portal generated_at: ${exportJson.portal_generated_at || 'unknown'} | current_month: ${exportJson.current_month || 'unknown'}`);
printSection('Occupancy mismatches', occupancyDiffs);
printSection('Insurance mismatches', insuranceDiffs);
printSection('Enquiries mismatches', enquiriesDiffs);
