// Follow-up scoping check after the Self Storage Rate/Real Rate fallback fix (Enfield/Aug 2025):
// that fix only applies to the SELF-STORAGE-SPECIFIC rate (ssRate/ssReal). The PORTFOLIO-WIDE Rate/
// Real Rate (all unit types combined, rr.rate_per_sqft_ann/real_rate_per_sqft_ann) still has NO
// fallback per the locked spec — if RentRoll shows 0 total area for a site/month while Occupancy
// shows real occupancy, Rate/Real Rate would show £0 too, same failure mode, just not yet checked.
// This scans every stored rent_roll+occupancy pair for that exact conflict: occupancy shows occupied
// units > 0, but RentRoll's own area_sum is 0 (or missing).
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-total-rate-zero.js
import { admin } from '../lib/supabaseAdmin.js';

const PAGE = 1000;
async function fetchAll(report, cols) {
  let all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin.from('raw_report').select(cols).eq('report', report).range(from, from + PAGE - 1);
    if (error) { console.error(error.message); process.exit(1); }
    all = all.concat(data);
    if (data.length < PAGE) break;
  }
  return all;
}

const occRows = await fetchAll('occupancy', 'site_code, month, data');
const rrRows = await fetchAll('rent_roll', 'site_code, month, data');
const rrIndex = {};
for (const r of rrRows) rrIndex[`${r.site_code}|${String(r.month).slice(0, 7)}`] = r.data;

const conflicts = [];
for (const r of occRows) {
  const mk = String(r.month).slice(0, 7);
  const occUnits = r.data?.occupied_units || 0;
  if (!occUnits) continue;
  const rr = rrIndex[`${r.site_code}|${mk}`];
  const rrArea = rr?.area_sum || 0;
  if (!rrArea) conflicts.push({ site: r.site_code, month: mk, occUnits, hasRentRollRow: !!rr });
}

console.log(`Checked ${occRows.length} occupancy rows.\n`);
console.log(`Conflicts (Occupancy shows occupied units, but RentRoll's TOTAL area_sum is 0): ${conflicts.length}\n`);
const byMonth = {};
for (const c of conflicts) (byMonth[c.month] ??= []).push(`${c.site}${c.hasRentRollRow ? '' : '(no row)'}`);
for (const mk of Object.keys(byMonth).sort()) console.log(`${mk}: ${byMonth[mk].join(', ')}`);
if (!conflicts.length) console.log('None found — this conflict does not affect the portfolio-wide Rate/Real Rate.');
process.exit(0);
