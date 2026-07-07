// Follow-up to check-backfill-coverage.js: rent_roll HAS a raw_report row for 106 historical
// months, so the "report was never pulled" hypothesis is dead. But lib/pull.js stores the
// PARSED output of reportMap.js's rent_roll.parse() directly into raw_report.data — NOT the raw
// SiteLink rows (see pull.js line ~100-103: `data` comes straight out of `pullReport()`, which
// calls `parse(rows)` before returning). Once a month is locked (pull.js's prevLocked skip logic),
// that parsed JSON is frozen forever and never re-parsed, even if reportMap.js's parse() function
// changes later. rent_roll.parse() has been edited repeatedly this project (self_storage sub-
// object, rent_sum/area_sum raw-sum fields, unit_type_areas — all added/changed across several
// dates per the comments in lib/reportMap.js). If an old month's stored data predates one of
// those additions, `rr.self_storage` (or its rent_sum/area_sum) simply won't exist in the frozen
// JSON — producing ssRate=0 forever for that month, independent of the CURRENT parse() code being
// correct. This dumps the actual top-level keys (and self_storage sub-keys, if present) of one
// site's stored rent_roll row for a spread of historical + recent months to confirm.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-rentroll-raw-shape.js [siteCode]
import { admin } from '../lib/supabaseAdmin.js';

const loc = (process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',')[0] || '').trim();
const testMonths = ['2020-09-01', '2022-01-01', '2023-06-01', '2024-01-01', '2025-01-01', '2026-01-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01'];

console.log(`Site ${loc} — stored rent_roll parsed-JSON shape per month\n`);
for (const mk of testMonths) {
  const { data, error } = await admin.from('raw_report').select('data,pulled_at')
    .eq('site_code', loc).eq('report', 'rent_roll').eq('month', mk).maybeSingle();
  if (error) { console.log(`${mk}: ERROR ${error.message}`); continue; }
  if (!data) { console.log(`${mk}: (no row)`); continue; }
  const d = data.data || {};
  const topKeys = Object.keys(d).join(', ');
  const ss = d.self_storage;
  const ssInfo = ss ? `self_storage keys: ${Object.keys(ss).join(', ')} | rate=${ss.rate_per_sqft_ann} area_sum=${ss.area_sum} rent_sum=${ss.rent_sum}` : 'self_storage: MISSING';
  console.log(`${mk}  (pulled_at ${String(data.pulled_at).slice(0, 10)})`);
  console.log(`  top-level keys: ${topKeys}`);
  console.log(`  ${ssInfo}\n`);
}
process.exit(0);
