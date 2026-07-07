// Batch fix for the 117 "suspicious" rent_roll rows found by check-rentroll-suspicious-months.js —
// sites with tenants > 0 but <=1 unit_type recorded (confirmed via probe:enfield-rentroll-live to be
// genuinely stale/truncated data, not a SiteLink historical-query limitation: the live API returns
// the missing unit types just fine for the same site+period). Recurring mostly for L005 (Brighton)
// and L008 (Enfield) across nearly every month since 2021, plus scattered hits on L004/L007/L020/
// L021/L022/L024/L025/L026. Unlike repull-report-all-months.js (which re-pulls EVERY site for EVERY
// month — wasteful here since most months only have 1-3 flagged sites out of 27), this re-pulls ONLY
// the specific flagged (site, month) pairs, one at a time.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/repull-rentroll-flagged.js
import { admin } from '../lib/supabaseAdmin.js';
import { pullReport } from '../lib/reportMap.js';
import { buildPayload } from '../lib/buildPayload.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function tryPull(key, loc, start, end) {
  const backoff = [0, 2000, 5000];
  for (let attempt = 1; ; attempt++) {
    try { return await pullReport(key, loc, start, end); }
    catch (e) { if (attempt >= backoff.length) throw e; await sleep(backoff[attempt]); }
  }
}

console.log('Scanning for flagged (site, month) pairs...');
const PAGE = 1000;
let all = [];
for (let from = 0; ; from += PAGE) {
  const { data, error } = await admin.from('raw_report').select('site_code, month, data').eq('report', 'rent_roll').range(from, from + PAGE - 1);
  if (error) { console.error(error.message); process.exit(1); }
  all = all.concat(data);
  if (data.length < PAGE) break;
}
const flagged = all.filter((r) => (r.data?.tenants || 0) > 0 && (r.data?.unit_types || []).length <= 1)
  .map((r) => ({ site_code: r.site_code, month: String(r.month).slice(0, 10) }));
console.log(`Found ${flagged.length} flagged (site, month) pairs to re-pull.\n`);
if (!flagged.length) { console.log('Nothing to do.'); process.exit(0); }

let ok = 0, failed = 0;
const startedAt = Date.now();
for (let i = 0; i < flagged.length; i++) {
  const { site_code, month } = flagged[i];
  const [y, m] = month.split('-').map(Number);
  const monthStart = new Date(y, m - 1, 1);
  const monthEnd = new Date(y, m, 0);

  const { error: delErr } = await admin.from('raw_report').delete().eq('report', 'rent_roll').eq('site_code', site_code).eq('month', month);
  if (delErr) { console.error(`[${site_code} ${month}] delete failed: ${delErr.message} — skipping`); failed++; continue; }

  try {
    const { data } = await tryPull('rent_roll', site_code, monthStart, monthEnd);
    const { error } = await admin.from('raw_report').upsert(
      { site_code, month, report: 'rent_roll', data, pulled_at: new Date().toISOString() },
      { onConflict: 'site_code,month,report' });
    if (error) throw new Error(error.message);
    ok++;
    const typeCount = (data?.unit_types || []).length;
    const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
    console.log(`[${i + 1}/${flagged.length}] ${site_code} ${month}: ok — now ${typeCount} unit type(s) (${elapsedMin}min elapsed)`);
  } catch (e) {
    failed++;
    console.error(`[${i + 1}/${flagged.length}] ${site_code} ${month}: FAILED — ${e.message}`);
  }
}

console.log(`\nDone. ${ok} ok, ${failed} failed. Rebuilding portal_payload...`);
const now = new Date();
const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const payload = await buildPayload(currentMonthStart, prevMonthStart);
const { error: ppErr } = await admin.from('portal_payload').upsert({ id: 1, generated_at: new Date().toISOString(), payload });
if (ppErr) { console.error('portal_payload write failed:', ppErr.message); process.exit(1); }
console.log('portal_payload rebuilt.');
process.exit(0);
