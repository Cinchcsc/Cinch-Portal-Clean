// Follow-up to check-enfield-aug2025-unittypes.js: our STORED rent_roll data for Enfield (L008) in
// Aug 2025 only has an "Office" unit_type row — no "Self Storage"/"Bulk" — even though Occupancy
// Statistics confirms 53/93 self-storage-type units existed there that month, and later months (Jan/
// Jun 2026) DO show "Self Storage"/"Bulk" rows for the same site. This queries SiteLink's live
// RentRoll API directly, right now, for L008 with an Aug 2025 date range, to see whether the missing
// unit types are a genuine upstream/SiteLink limit for that historical query (i.e. re-pulling again
// wouldn't help) or whether today's live query actually returns the missing rows (i.e. our stored data
// is just stale/wrong and a targeted re-pull would fix it).
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-enfield-rentroll-live.js
import { callReport } from '../lib/sitelink.js';

const loc = 'L008';
const start = new Date(2025, 7, 1);   // Aug 2025
const end = new Date(2025, 7, 31);

console.log(`Querying LIVE SiteLink RentRoll for ${loc}, Aug 2025 (right now)...\n`);
const { rows } = await callReport('RentRoll', loc, start, end);
console.log(`Total rows returned: ${rows.length}\n`);

const byType = {};
for (const r of rows) {
  const t = r.sTypeName || '(blank)';
  byType[t] = (byType[t] || 0) + 1;
}
console.log('Row count by sTypeName:');
for (const [t, n] of Object.entries(byType)) console.log(`  ${t}: ${n}`);

if (!byType['Self Storage'] && !Object.keys(byType).some((t) => /self.?storage/i.test(t))) {
  console.log('\n*** Even the LIVE query right now returns no Self Storage rows for this historical range ***');
  console.log('This points to a SiteLink/upstream limitation for this site+period, not a stale-pull issue —');
  console.log('re-running repull-report-month.js would very likely NOT fix it.');
} else {
  console.log('\n*** The LIVE query DOES include Self Storage rows — our stored data is stale. ***');
  console.log(`Fix: node --env-file=.env scripts/repull-report-month.js rent_roll 2025-08`);
}
process.exit(0);
