// Follow-up: /api/portfolio?from=2025-08&to=2025-08 returns only 23 of 27 sites — L024 (Newcastle),
// L025 (Shoreham-By-Sea), L026 (Paulton), L027 (Exeter) are missing. buildPayloadRange()/buildIndex()
// only include a site for a given month if `occupancy.total_units > 0` that month, so this checks
// whether that's a genuine "store not open / no units yet" situation for Aug 2025, or something else
// (e.g. occupancy row missing entirely, or present with a real unit count that's being miscounted).
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-aug2025-missing-sites.js
import { admin } from '../lib/supabaseAdmin.js';

const codes = ['L024', 'L025', 'L026', 'L027'];
const { data, error } = await admin
  .from('raw_report')
  .select('site_code, month, report, data, pulled_at')
  .in('site_code', codes)
  .eq('report', 'occupancy')
  .gte('month', '2025-08-01')
  .lt('month', '2025-09-01');
if (error) { console.error(error.message); process.exit(1); }

console.log(`Found ${data.length} occupancy row(s) for ${codes.join(', ')} in Aug 2025:\n`);
for (const r of data) {
  console.log(`${r.site_code}  month=${r.month}  pulled_at=${r.pulled_at}  total_units=${r.data?.total_units}  occupied_units=${r.data?.occupied_units}`);
}
const found = new Set(data.map((r) => r.site_code));
const noRowAtAll = codes.filter((c) => !found.has(c));
if (noRowAtAll.length) console.log(`\nNo occupancy row AT ALL for Aug 2025: ${noRowAtAll.join(', ')}`);

// Also check when each of these sites' occupancy data FIRST appears (earliest month with total_units>0),
// to see if Aug 2025 predates when the store actually opened.
console.log('\nEarliest month with total_units > 0 for each site:');
for (const code of codes) {
  const { data: rows } = await admin.from('raw_report').select('month, data').eq('site_code', code).eq('report', 'occupancy').order('month', { ascending: true });
  const first = (rows || []).find((r) => (r.data?.total_units || 0) > 0);
  console.log(`  ${code}: ${first ? first.month : 'never has total_units > 0 in any stored month'}`);
}
process.exit(0);
