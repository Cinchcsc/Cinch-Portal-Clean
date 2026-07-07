// Scoping check after finding Enfield (L008) Aug/Jun 2025 rent_roll data only had an "Office"
// unit_type row (missing "Self Storage"/"Bulk" entirely), confirmed via probe:enfield-rentroll-live
// to be STALE data, not a real SiteLink limitation — the live API returns 93 Self Storage rows for
// that exact site+period right now. Since that stale data came from the same full historical re-pull
// batch run earlier this session (repull-report-all-months.js rent_roll, pulled_at ~2026-07-06), this
// could be a broader silent-truncation issue from that run (e.g. transient SiteLink errors that didn't
// throw, just returned partial rows) rather than an Enfield-only problem. This scans EVERY stored
// rent_roll row and flags any that look suspicious: a SINGLE unit_type entry only (real sites
// typically have 2+ types — Self Storage, Office, Drive Up, Enterprise, Mailbox, etc.), or zero
// unit_types at all despite tenants > 0.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-rentroll-suspicious-months.js
import { admin } from '../lib/supabaseAdmin.js';

const PAGE = 1000;
let all = [];
for (let from = 0; ; from += PAGE) {
  const { data, error } = await admin.from('raw_report').select('site_code, month, data, pulled_at').eq('report', 'rent_roll').range(from, from + PAGE - 1);
  if (error) { console.error(error.message); process.exit(1); }
  all = all.concat(data);
  if (data.length < PAGE) break;
}
console.log(`Scanned ${all.length} rent_roll rows.\n`);

const suspicious = all.filter((r) => {
  const types = r.data?.unit_types || [];
  const tenants = r.data?.tenants || 0;
  return tenants > 0 && types.length <= 1;
});

console.log(`Suspicious rows (tenants > 0 but <=1 unit_type — likely truncated pull): ${suspicious.length}\n`);
const byMonth = {};
for (const r of suspicious) {
  const mk = String(r.month).slice(0, 7);
  (byMonth[mk] ??= []).push(r.site_code);
}
for (const mk of Object.keys(byMonth).sort()) {
  console.log(`${mk}: ${byMonth[mk].length} site(s) — ${byMonth[mk].join(', ')}`);
}
if (!suspicious.length) console.log('None found — Enfield may be an isolated case.');
process.exit(0);
