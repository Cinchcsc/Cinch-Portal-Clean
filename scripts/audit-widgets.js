// Consolidated LIVE audit across every site for the 3 widgets still flagged as wrong (2 Jul 2026):
//   1. Reservations vs Move-outs — portfolio total ~1499 vs legacy target ~446 (>3x too high).
//   2. Autobill — % looks off; iAutoBillType codes [1,2] were never independently confirmed as
//      "on autobill" (no live column dump has actually shown its real distribution of values).
//   3. Enquiries — still ~2x the legacy portal's last-complete-month total even after the
//      current-vs-previous-month fix.
// (Debtor Levels' bug was found by code review, not data — see lib/reportMap.js's past_due parser
// comment — no need to audit that one live.)
// This makes MANY live SiteLink calls (27 sites x 3 reports) — expect it to take several minutes,
// similar to a full pull. PII-SAFE: only prints aggregated counts/breakdowns, no tenant data.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/audit-widgets.js
import { callReport, callReservationList } from '../lib/sitelink.js';

const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
const now = new Date();
// Last COMPLETE month (matches what the portal now uses for Enquiries/Move-ins/Move-outs).
const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const prevEnd = new Date(now.getFullYear(), now.getMonth(), 0);
console.log(`${locations.length} sites · last complete month window ${prevStart.toISOString().slice(0, 10)} -> ${prevEnd.toISOString().slice(0, 10)}\n`);

const isBlank = (v) => v === undefined || v === null || v === '' || v === '0001-01-01T00:00:00';
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? ''));

let resActiveTotal = 0, resAlreadyMovedIn = 0, resCancelTypeSetButNotCancelled = 0;
const resStatusCounts = {};
let autobillCounts = {}; // value -> count, portfolio-wide
let tenantsTotal = 0;
let enqPhone = 0, enqWalkin = 0, enqWeb = 0, enqEmail = 0, enqOther = 0, enqRows = 0;

for (const loc of locations) {
  process.stderr.write(`[audit] ${loc}...\n`);

  // --- 1. Reservations ---
  try {
    const { rows: resRows } = await callReservationList(loc);
    const activeLooking = resRows.filter(r => isBlank(r.dCancelled) && !isBlank(r.dNeeded) && new Date(r.dNeeded) > now);
    resActiveTotal += activeLooking.length;
    for (const r of activeLooking) {
      const k = String(r.QTRentalStatusID); resStatusCounts[k] = (resStatusCounts[k] || 0) + 1;
      if (!isBlank(r.QTCancellationTypeID) && Number(r.QTCancellationTypeID) !== 0) resCancelTypeSetButNotCancelled++;
    }
    // Cross-check against this site's occupied RentRoll tenants (last complete month).
    const { rows: rrRows } = await callReport('RentRoll', loc, prevStart, prevEnd);
    const occupiedIds = new Set(rrRows.filter(r => yes(r.bRented)).map(r => String(r.TenantID)));
    resAlreadyMovedIn += activeLooking.filter(r => occupiedIds.has(String(r.TenantID))).length;

    // --- 2. Autobill (from the same RentRoll pull) ---
    for (const r of rrRows) {
      if (!yes(r.bRented)) continue;
      tenantsTotal++;
      const v = String(r.iAutoBillType ?? '(blank)');
      autobillCounts[v] = (autobillCounts[v] || 0) + 1;
    }
  } catch (e) { console.log(`  ${loc}: reservations/rentroll error: ${e.message}`); }

  // --- 3. Enquiries ---
  try {
    const { rows: inqRows } = await callReport('InquiryTracking', loc, prevStart, prevEnd);
    enqRows += inqRows.length;
    for (const r of inqRows) {
      const k = String(r.sInquiryType ?? '').toLowerCase();
      if (k === 'phone') enqPhone++; else if (k === 'walkin') enqWalkin++; else if (k === 'web') enqWeb++; else if (k === 'email') enqEmail++; else enqOther++;
    }
  } catch (e) { console.log(`  ${loc}: enquiries error: ${e.message}`); }
}

console.log('\n=== Reservations vs Move-outs ===');
console.log(`Active-looking (current filter): ${resActiveTotal}   Target: ~446`);
console.log(`Of those, already an occupied RentRoll tenant (should NOT count): ${resAlreadyMovedIn}`);
console.log(`Of those, QTCancellationTypeID is SET despite dCancelled being blank (likely actually cancelled): ${resCancelTypeSetButNotCancelled}`);
console.log(`If we exclude both groups: ${resActiveTotal - resAlreadyMovedIn - resCancelTypeSetButNotCancelled}`);
console.log('QTRentalStatusID breakdown (portfolio-wide, active-looking rows):', JSON.stringify(resStatusCounts, null, 2));

console.log('\n=== Autobill ===');
console.log(`Total occupied tenants (RentRoll, bRented=true): ${tenantsTotal}`);
console.log('iAutoBillType value distribution (portfolio-wide):', JSON.stringify(autobillCounts, null, 2));
console.log('Current code counts iAutoBillType in [1,2] as "on autobill" — compare against the distribution above.');

console.log('\n=== Enquiries (last complete month, all sites) ===');
console.log(`total rows: ${enqRows}`);
console.log(`Phone=${enqPhone}  Walk-in=${enqWalkin}  Web=${enqWeb}  Email=${enqEmail}  Other(uncounted)=${enqOther}`);
console.log(`Web+Email (displayed "Web"): ${enqWeb + enqEmail}   Total (Phone+Walk-in+Web+Email): ${enqPhone + enqWalkin + enqWeb + enqEmail}`);
console.log('Target (legacy portal, Jun 2026): Phone 269, Walk-ins 233, Web 3675, Total 4178');
process.exit(0);
