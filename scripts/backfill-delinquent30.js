// Task #72 — delinquent_30plus_total/_units (lib/reportMap.js's management parser, ADDED 7 Jul 2026)
// needs the FULL multi-table SOAP response to compute (extractRows() only surfaces the single largest
// table, UnitActivity — Delinquency is a separate, smaller table in the same response). Historical
// 'management' rows pulled BEFORE 7 Jul 2026 have neither the field (parsed by the old code, which
// didn't compute it) NOR a stored raw_response (that storage change landed the same day) — so they
// can't be fixed via reparse-report.js alone. Rows pulled ON OR AFTER 7 Jul (or re-pulled since) DO
// have raw_response stored, so those get fixed for free, zero SiteLink calls.
// This script does both in one pass over every stored 'management' row missing the field: reparse
// locally wherever raw_response exists (free), live re-pull (one call) wherever it doesn't.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/backfill-delinquent30.js
import { admin } from '../lib/supabaseAdmin.js';
import { REPORTS, pullReport } from '../lib/reportMap.js';
import { extractRows } from '../lib/sitelink.js';
import { buildPayload } from '../lib/buildPayload.js';

const spec = REPORTS.management;

async function withRetry(fn, attempts = 3, delayMs = 2000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

const PAGE = 500;
async function fetchStoredManagementRows() {
  let all = [];
  for (let from = 0; ; from += PAGE) {
    const data = await withRetry(async () => {
      const res = await admin.from('raw_report').select('id,site_code,month,data').eq('report', 'management').order('id').range(from, from + PAGE - 1);
      if (res.error) throw new Error(res.error.message);
      return res.data;
    });
    all = all.concat(data);
    if (!data || data.length < PAGE) break;
  }
  return all;
}

console.log("Scanning stored 'management' rows for missing delinquent_30plus_total...");
const rows = await fetchStoredManagementRows();
const stale = rows.filter((r) => r.data && r.data.delinquent_30plus_total === undefined);
console.log(`${rows.length} total management rows, ${stale.length} missing delinquent_30plus_total.\n`);
if (!stale.length) { console.log('Nothing to backfill.'); process.exit(0); }

const now = new Date();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function tryPull(key, loc, start, end) {
  const backoff = [0, 2000, 5000];
  for (let attempt = 1; ; attempt++) {
    try { return await pullReport(key, loc, start, end); }
    catch (e) { if (attempt >= backoff.length) throw e; await sleep(backoff[attempt]); }
  }
}

let reparsed = 0, repulled = 0, failed = 0;
for (const r of stale) {
  const mk = String(r.month).slice(0, 7);
  const [y, m] = mk.split('-').map(Number);
  const startDate = new Date(y, m - 1, 1);
  const fullMonthEnd = new Date(y, m, 0);
  const isCurrentMonth = y === now.getFullYear() && m === now.getMonth() + 1;
  const endDate = isCurrentMonth && fullMonthEnd > now ? now : fullMonthEnd;

  try {
    const raw_response = await withRetry(async () => {
      const res = await admin.from('raw_report').select('raw_response').eq('id', r.id).single();
      if (res.error) throw new Error(res.error.message);
      return res.data.raw_response;
    });

    if (raw_response) {
      // Free path — replay the already-stored raw SOAP response through the current parser.
      const extracted = extractRows(raw_response);
      const data = spec.parse(extracted, startDate, endDate, raw_response);
      await withRetry(async () => {
        const res = await admin.from('raw_report').update({ data }).eq('id', r.id);
        if (res.error) throw new Error(res.error.message);
      });
      reparsed++;
    } else {
      // No raw_response stored (pulled before 7 Jul 2026) — needs a real live call. Store
      // raw_response this time too, so this row is reparse-able for free from now on.
      const { data, raw } = await tryPull('management', r.site_code, startDate, endDate);
      await withRetry(async () => {
        const res = await admin.from('raw_report').update({ data, raw_response: raw ?? null, pulled_at: new Date().toISOString() }).eq('id', r.id);
        if (res.error) throw new Error(res.error.message);
      });
      repulled++;
    }
  } catch (e) {
    failed++;
    console.error(`  ${r.site_code}/${mk}: FAILED — ${e.message}`);
  }
  const done = reparsed + repulled + failed;
  if (done % 25 === 0 || done === stale.length) console.log(`  ...${done}/${stale.length} processed (${reparsed} reparsed free, ${repulled} re-pulled live, ${failed} failed)`);
}

console.log(`\nDone — ${reparsed} reparsed locally (free), ${repulled} re-pulled live, ${failed} failed.`);
console.log('Rebuilding portal_payload...');
const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const payload = await buildPayload(currentMonthStart, prevMonthStart);
const { error: ppErr } = await admin.from('portal_payload').upsert({ id: 1, generated_at: new Date().toISOString(), payload });
if (ppErr) { console.error('portal_payload write failed:', ppErr.message); process.exit(1); }
console.log('Done — portal_payload rebuilt.');
process.exit(failed > (reparsed + repulled) ? 1 : 0);
