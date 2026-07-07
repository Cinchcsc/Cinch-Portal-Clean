// Diagnostic: list ALL stored occupancy rows for a site since April, to expose duplicate
// month rows (e.g. 2026-05-01 vs 2026-05-31) that collide on the YYYY-MM key in buildPayload.
// READ-ONLY. Never prints credentials.   node --env-file=.env scripts/diag-dupes.js [LOC]
import { admin } from '../lib/supabaseAdmin.js';

const LOC = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',')[0].trim();
const { data, error } = await admin.from('raw_report')
  .select('month,report,pulled_at,data')
  .eq('site_code', LOC).eq('report', 'occupancy').gte('month', '2026-03-01').order('month');
if (error) { console.error(error.message); process.exit(1); }

console.log(`\nOccupancy rows for ${LOC} (since 2026-03):  ${data.length} rows`);
const byKey = {};
for (const r of data) {
  const d = r.data || {};
  const mk = String(r.month).slice(0, 7);
  (byKey[mk] ??= []).push(r);
  console.log(`  month=${r.month}  key=${mk}  pulled=${r.pulled_at}  occ=${d.occupied_units}/${d.total_units}  grossOcc=${d.gross_occupied}  -> ${d.gross_occupied > 0 ? 'NEW' : 'OLD'}`);
}
console.log('\nCollisions (same YYYY-MM, >1 row):');
let any = false;
for (const k of Object.keys(byKey)) if (byKey[k].length > 1) { any = true; console.log(`  ${k}: ${byKey[k].length} rows  (months: ${byKey[k].map(r => r.month).join(', ')})`); }
if (!any) console.log('  none');
process.exit(0);
