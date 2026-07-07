// Read-only, no SiteLink calls: replicates buildPayload.js's EXACT pipeline (fetchAllRaw's report
// filter + de-dupe-by-pulled_at + idx build) for a few sites, to find why Bicester/Leighton Buzzard/
// Letchworth (L001-L003) show real POS-category charges in their raw June `financial` row but the
// live payload's computed merchandise.chargeFromFinancial came out to £0 for them (only Earlsfield/
// L014 was nonzero in check-merch-insurance-live.js's output) — isolating whether this is a raw-data
// gap, a month-key mismatch, a de-dupe bug, or something else.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-merch-pipeline.js
import { admin } from '../lib/supabaseAdmin.js';

const ALL_REPORTS = ['occupancy', 'rent_roll', 'management', 'move_ins_outs', 'past_due', 'scheduled_outs',
  'insurance_roll', 'insurance_activity', 'lead_funnel', 'marketing', 'merchandise', 'financial', 'rate_changes',
  'reservations', 'true_revenue', 'rental_activity'];

const SITES = (process.argv[2] || 'L001,L002,L003,L014').split(',');

async function fetchAllRaw() {
  const out = []; const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin.from('raw_report')
      .select('site_code,month,report,data,pulled_at').in('report', ALL_REPORTS).in('site_code', SITES).range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

const rows = await fetchAllRaw();
console.log(`Fetched ${rows.length} raw rows for sites: ${SITES.join(', ')}\n`);

const idx = {}; const chosenAt = {};
let dupesSkipped = 0;
for (const r of rows) {
  const mk = String(r.month).slice(0, 7);
  const key = `${r.site_code}|${mk}|${r.report}`, at = r.pulled_at || '';
  if (chosenAt[key] != null && !(at > chosenAt[key])) { dupesSkipped++; continue; }
  chosenAt[key] = at;
  ((idx[r.site_code] ??= {})[mk] ??= {})[r.report] = r.data;
}
console.log(`De-dupe skipped ${dupesSkipped} older duplicate rows.\n`);

const now = new Date();
const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const prevKey = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`;

for (const code of SITES) {
  console.log(`=== ${code} / ${prevKey} ===`);
  const c = idx[code]?.[prevKey];
  if (!c) { console.log('  NO idx entry at all for this site/month!'); continue; }
  console.log(`  reports present in idx: ${Object.keys(c).join(', ')}`);
  const fin = c.financial || {};
  console.log(`  fin.categories: ${fin.categories ? fin.categories.length : 'undefined'} rows`);
  const posRows = (fin.categories || []).filter(cat => cat.category === 'POS');
  console.log(`  POS rows: ${posRows.length}, sum=£${posRows.reduce((a, cat) => a + (cat.charge || 0), 0).toFixed(2)}`);
  console.log();
}
process.exit(0);
