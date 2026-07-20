// PROBE (20 Jul 2026), READ-ONLY, zero SiteLink calls — reopens task #308 (rate annualization).
//
// BACKGROUND: R6 told Richard today that Rate per ft² comes from the Rent Roll, and any tenant
// billed every 4 weeks has their rate converted to a monthly equivalent by ×1.0833 (=13/12) BEFORE
// the widget's "×12" annualization runs. lib/reportMap.js's rent_roll parser currently does NOT do
// this — its comment says it "superseded an earlier ×13/12 heuristic that is no longer authoritative."
//
// Git archaeology (baseline commit 810a574, before this repo's own history) recovered the ORIGINAL
// investigation: scripts/probe-28day-billing-preview.js and probe-billing-info-report.js both tried
// to find a real per-tenant field on RentRoll (or a separate "Tenant Billing Info"-style report)
// that flags 4-weekly/28-day billing, so the ×1.0833 could be applied to the right tenants only.
// probe-billing-info-report.js explicitly warned it wasn't finding one and would need SiteLink
// support or a direct answer from someone who knows the schema (i.e. R6) to proceed. It's not
// visible from git history alone whether that ever got a definitive answer — this probe re-asks the
// same question against everything we have stored now, so we don't have to guess.
//
// This does TWO things:
//   (1) Dumps the full raw column list from a stored RentRoll row (flattened via lib/sitelink.js's
//       own extractRows(), so this sees exactly what the real parser sees) and flags anything that
//       LOOKS like a billing-cycle/frequency field.
//   (2) As a fallback proxy (same idea as the old probe-freq.js/probe-billing2.js), computes each
//       occupied unit's IMPLIED billing period as (dcStdWeeklyRate × 52) ÷ dcStdRate — if real
//       4-weekly billing exists and dcStdWeeklyRate is a genuine weekly figure, this ratio should
//       cluster near 12 (monthly) or 13 (4-weekly). If it's just noisy/scattered around 12, that's
//       evidence there's no real population of 4-weekly-billed tenants in this data, or that
//       dcStdWeeklyRate isn't a reliable weekly-rate field to derive this from.
//
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-rentroll-billing-cycle.js [siteCode]
import { admin } from '../lib/supabaseAdmin.js';
import { extractRows } from '../lib/sitelink.js';

const onlySite = process.argv[2] || null;

async function withRetry(fn, attempts = 3, delayMs = 2000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((res) => setTimeout(res, delayMs));
    }
  }
  throw lastErr;
}

const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? '').trim());

// Fetch the most recent stored month per site (paginated id-only query first — same statement-
// timeout-safe pattern as probe-leadfunnel-table-selection.js — then stream raw_response one at a time).
const PAGE = 500;
let idRows = [];
for (let from = 0; ; from += PAGE) {
  let q = admin.from('raw_report').select('id,site_code,month')
    .eq('report', 'rent_roll').not('raw_response', 'is', null).order('site_code').order('month', { ascending: false }).range(from, from + PAGE - 1);
  if (onlySite) q = q.eq('site_code', onlySite);
  const { data, error } = await withRetry(async () => {
    const res = await q; if (res.error) throw new Error(res.error.message); return res;
  });
  idRows = idRows.concat(data);
  if (!data || data.length < PAGE) break;
}
// Keep only the newest stored month per site (cheap way to get one representative recent row per site
// without re-querying) — good enough for a column-existence + ratio-distribution check.
const newestPerSite = {};
for (const r of idRows) if (!newestPerSite[r.site_code] || r.month > newestPerSite[r.site_code].month) newestPerSite[r.site_code] = r;
const targets = Object.values(newestPerSite);
console.log(`Checking newest stored rent_roll month for ${targets.length} site(s)...\n`);

let allCols = new Set();
const cycleRe = /bill|cycle|frequen|28|period|anniv|week/i;
let cycleCols = new Set();
const ratioHist = {};
let ratioClean12 = 0, ratioClean13 = 0, ratioAmbiguous = 0, ratioMissing = 0;

for (const t of targets) {
  const raw_response = await withRetry(async () => {
    const { data, error } = await admin.from('raw_report').select('raw_response').eq('id', t.id).single();
    if (error) throw new Error(error.message); return data.raw_response;
  });
  const rows = extractRows(raw_response);
  if (!rows.length) continue;
  for (const k of Object.keys(rows[0])) { allCols.add(k); if (cycleRe.test(k)) cycleCols.add(k); }

  const occ = rows.filter((r) => yes(r.bRented));
  for (const r of occ) {
    const w = num(r.dcStdWeeklyRate), s = num(r.dcStdRate) || num(r.dcStandardRate);
    if (!w || !s) { ratioMissing++; continue; }
    const p = (w * 52) / s;
    const bucket = p.toFixed(1);
    ratioHist[bucket] = (ratioHist[bucket] || 0) + 1;
    if (Math.abs(p - 12) < 0.25) ratioClean12++;
    else if (Math.abs(p - 13) < 0.25) ratioClean13++;
    else ratioAmbiguous++;
  }
}

console.log(`ALL RentRoll columns seen (${allCols.size}):`);
console.log('  ' + [...allCols].sort().join(', '));
console.log(`\nColumns matching /bill|cycle|frequen|28|period|anniv|week/i (${cycleCols.size}):`);
console.log(cycleCols.size ? '  ' + [...cycleCols].join(', ') : '  (none — no obvious billing-cycle flag field exists on RentRoll)');

console.log('\nImplied-period ratio (dcStdWeeklyRate × 52 ÷ dcStdRate|dcStandardRate), occupied units:');
console.log('  ' + JSON.stringify(ratioHist));
console.log(`  ~12 (monthly): ${ratioClean12} | ~13 (4-weekly): ${ratioClean13} | ambiguous/other: ${ratioAmbiguous} | missing a field: ${ratioMissing}`);
console.log(ratioClean13 > 0
  ? '\nSome units DO show an implied ~13-period (4-weekly-like) ratio — worth a closer look before dismissing the adjustment.'
  : '\nNo units show a clean ~13-period ratio here — no evidence of a real 4-weekly-billed population via this proxy, in this sample.');
process.exit(0);
