// Preview-only (does NOT change any production formula): Michael's uploaded KPI Widget Reference
// doc says tenants billed on a 28-day cycle should have their rate scaled by ×1.0833 to normalise
// to a calendar-month equivalent, before it feeds Monthly Rent Roll / Rate per Sq Ft. We don't apply
// this anywhere currently. Before touching lib/reportMap.js, this:
//   (1) dumps RentRoll's full column list to find a real billing-cycle field (something like
//       iBillDay/sBillCycle/iBillingFrequency) so we know WHICH tenants are actually on 28-day
//       billing — right now we don't know if such a column exists or what it's called;
//   (2) if found, computes portfolio-wide Rate per Sq Ft BOTH with and without the 1.0833 adjustment
//       applied to those tenants, side by side, so Michael can see the before/after in one glance
//       without any code being changed yet.
// PII-SAFE: aggregated £/sq ft figures and column names only.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-28day-billing-preview.js
import { callReport } from '../lib/sitelink.js';

const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const end = new Date(now.getFullYear(), now.getMonth(), 0);
const num = (r, ...keys) => { for (const k of keys) { const v = Number(r[k]); if (Number.isFinite(v)) return v; } return 0; };
const str = (v) => (v ?? '').toString().trim();
const yes = (v) => v === true || v === 1 || /^(1|true|yes)$/i.test(str(v));

console.log(`${locations.length} sites · last complete month ${start.toISOString().slice(0, 10)} -> ${end.toISOString().slice(0, 10)}\n`);

// Step 1: find the billing-cycle field on ONE site first (cheap check before pulling everything).
const { rows: sample } = await callReport('RentRoll', locations[0], start, end);
const cols = sample.length ? Object.keys(sample[0]).filter(c => !/^(diffgr|msdata)/i.test(c)) : [];
const cycleCandidates = cols.filter(c => /bill|cycle|frequen|28|period/i.test(c));
console.log('Candidate billing-cycle columns on RentRoll:', cycleCandidates.length ? cycleCandidates.join(', ') : '(none found)');
if (cycleCandidates.length) {
  console.log('\nDistinct values for each candidate (first site, occupied rows only):');
  const occRows = sample.filter(r => yes(r.bRented));
  for (const c of cycleCandidates) {
    const counts = {};
    for (const r of occRows) { const v = str(r[c]); counts[v] = (counts[v] || 0) + 1; }
    console.log(`  ${c}:`, JSON.stringify(counts));
  }
}

if (!cycleCandidates.length) {
  console.log('\nNo obvious 28-day-billing field found on RentRoll — cannot identify WHICH tenants are on a');
  console.log('28-day cycle vs standard monthly, so a before/after preview is not possible from this report');
  console.log('alone. This may live on a different report (Tenant Billing Info?) or require SiteLink support');
  console.log('to confirm the field name. Stopping here rather than guessing which tenants to adjust.');
  process.exit(0);
}

// Step 2: if a real field was found, compute the portfolio-wide preview.
const FACTOR = 1.0833;
let areaSum = 0, rentSum = 0, rentSumAdjusted = 0, adjustedTenants = 0, totalTenants = 0;
for (const loc of locations) {
  process.stderr.write(`[28day] ${loc}...\n`);
  try {
    const { rows } = await callReport('RentRoll', loc, start, end);
    for (const r of rows) {
      if (!yes(r.bRented)) continue;
      const area = num(r, 'Area', 'Area1'), rent = num(r, 'dcRent');
      if (!area) continue;
      areaSum += area; rentSum += rent; totalTenants++;
      // Heuristic: treat the first candidate column as the 28-day flag/value — adjust wording once we
      // see real values in Step 1's output above.
      const flagVal = str(r[cycleCandidates[0]]);
      const is28Day = /28/.test(flagVal) || flagVal === '1' || /true|yes/i.test(flagVal);
      if (is28Day) { rentSumAdjusted += rent * FACTOR; adjustedTenants++; } else { rentSumAdjusted += rent; }
    }
  } catch (e) { console.log(`  ${loc}: error: ${e.message}`); }
}

const rateNow = areaSum ? (rentSum / areaSum * 12) : 0;
const rateAdjusted = areaSum ? (rentSumAdjusted / areaSum * 12) : 0;
console.log(`\n${adjustedTenants}/${totalTenants} occupied tenants flagged as 28-day billed.`);
console.log(`\nRate per Sq Ft — CURRENT (no 28-day adjustment):   £${rateNow.toFixed(2)}`);
console.log(`Rate per Sq Ft — WITH 1.0833× 28-day adjustment:    £${rateAdjusted.toFixed(2)}`);
console.log(`Difference: £${(rateAdjusted - rateNow).toFixed(2)}  (${areaSum ? ((rateAdjusted / rateNow - 1) * 100).toFixed(2) : 0}%)`);
process.exit(0);
