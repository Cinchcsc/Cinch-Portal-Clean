// Follow-up to the Customer Insights fix (3 Jul 2026): the legacy portal's own tooltip says
//   Avg Length of Stay = Total Days Occupied / Ledger Count Occupied
// and showed ~480 days (> 1 year) as an example value. Our current `avg_length_of_stay_days`
// (lib/reportMap.js's rent_roll parser) averages RentRoll's `iAnnivDays` column across occupied
// tenants — but if that field is actually an ANNIVERSARY-CYCLE counter (days since the tenant's
// most recent lease anniversary, resetting every ~365 days) rather than TOTAL days since original
// move-in, it could never average above ~182 days and would badly understate long-tenured
// customers, even with the (Avg Length of Stay / 30.43) multiplier now correctly applied.
// This checks: (a) does iAnnivDays ever exceed 365 (proves/disproves the reset-every-year theory),
// (b) is there a move-in date column (e.g. dMoveIn) we could use instead to compute TRUE total
// days occupied as (today - move-in date), and cross-check the two.
// PII-SAFE: only prints date/day-count columns and aggregate stats, no tenant name/contact info.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-avg-stay.js
import { callReport } from '../lib/sitelink.js';

const loc = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean)[0];
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const end = new Date(now.getFullYear(), now.getMonth(), 0);

const { rows } = await callReport('RentRoll', loc, start, end);
const occupied = rows.filter(r => r.bRented === true || r.bRented === 1 || /^(1|true|yes)$/i.test(String(r.bRented ?? '')));
console.log(`site ${loc} · ${rows.length} total rows · ${occupied.length} occupied\n`);

const cols = Object.keys(rows[0] || {}).filter(k => !/^(diffgr|msdata)/i.test(k));
console.log('ALL COLUMNS:', cols.join(', '), '\n');
const dateLike = cols.filter(c => /^d[A-Z]/.test(c) || /move|anniv|start|lease/i.test(c));
console.log('candidate date/tenure columns:', dateLike.join(', '), '\n');

const anniv = occupied.map(r => Number(r.iAnnivDays)).filter(n => Number.isFinite(n));
console.log(`iAnnivDays: n=${anniv.length}  min=${Math.min(...anniv)}  max=${Math.max(...anniv)}  avg=${(anniv.reduce((a,b)=>a+b,0)/anniv.length).toFixed(1)}`);
console.log(anniv.some(n => n > 365) ? '  -> Some values EXCEED 365, so it is NOT a simple 0-365 anniversary-cycle counter (good sign for using it as total tenure).' : '  -> ALL values are <= 365 — consistent with an anniversary-cycle counter that resets yearly, NOT total days occupied. Likely the WRONG field for "Avg Length of Stay".');

if (cols.some(c => /move.?in/i.test(c))) {
  const miCol = cols.find(c => /move.?in/i.test(c));
  console.log(`\nFound a move-in-like column: ${miCol}. Sample values (first 5 occupied rows):`, occupied.slice(0, 5).map(r => r[miCol]));
  const days = occupied.map(r => {
    const d = r[miCol]; if (!d || d === '0001-01-01T00:00:00') return null;
    const diff = (now - new Date(d)) / 86400000;
    return diff > 0 ? diff : null;
  }).filter(n => n != null);
  if (days.length) console.log(`Computed (today - ${miCol}) days: n=${days.length}  avg=${(days.reduce((a,b)=>a+b,0)/days.length).toFixed(1)}  max=${Math.max(...days).toFixed(0)}`);
} else {
  console.log('\nNo obvious move-in-date column found among RentRoll fields — see ALL COLUMNS above for anything else date-like.');
}
process.exit(0);
