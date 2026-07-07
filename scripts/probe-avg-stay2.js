// Follow-up to probe-avg-stay.js: iAnnivDays was confirmed WRONG for "Avg Length of Stay" — only
// 37 of 315 occupied rows even had a value, and those ranged 1-30 (a monthly anniversary-billing
// countdown, not total tenancy days). RentRoll DOES have `dLeaseDate` (lease/move-in date) — this
// checks it as the real source: Avg Length of Stay = AVERAGE(today - dLeaseDate) across occupied
// tenants, matching the legacy tooltip's "Total Days Occupied / Ledger Count Occupied".
// PII-SAFE: only prints day-count stats, no tenant name/contact info.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-avg-stay2.js
import { callReport } from '../lib/sitelink.js';

const loc = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean)[0];
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const end = new Date(now.getFullYear(), now.getMonth(), 0);

const { rows } = await callReport('RentRoll', loc, start, end);
const isBlank = (v) => v === undefined || v === null || v === '' || v === '0001-01-01T00:00:00';
const occupied = rows.filter(r => r.bRented === true || r.bRented === 1 || /^(1|true|yes)$/i.test(String(r.bRented ?? '')));
console.log(`site ${loc} · ${occupied.length} occupied rows\n`);

console.log('Sample dLeaseDate values (first 10 occupied rows):', occupied.slice(0, 10).map(r => r.dLeaseDate));

const days = occupied.map(r => {
  if (isBlank(r.dLeaseDate)) return null;
  const d = (now - new Date(r.dLeaseDate)) / 86400000;
  return d > 0 ? d : null;
}).filter(n => n != null);

console.log(`\ndLeaseDate-based tenure: n=${days.length}/${occupied.length}  min=${Math.min(...days).toFixed(0)}  max=${Math.max(...days).toFixed(0)}  avg=${(days.reduce((a,b)=>a+b,0)/days.length).toFixed(1)} days`);
console.log('Legacy example (from Michael\'s screenshot): 480 days — compare the avg above against this order of magnitude.');
process.exit(0);
