// The point of the 7 Jul 2026 raw-storage change: almost every "wrong number" bug fixed this session
// (Debtor Levels' Delinquency Aging table, Rate per ft² by Customer Type, Move-ins/Move-outs 10x,
// rent/rate rounding...) was a bug in HOW WE PARSE SiteLink's response, not in SiteLink's own data —
// yet fixing it for already-pulled historical months always meant a full live re-pull (real SiteLink
// API calls, up to 1-3+ hours for a 122-month x 27-site report), even though SiteLink's answer for a
// CLOSED month never changes. Now that raw_report.raw_response stores the untouched SOAP response
// alongside the parsed `data`, this script replays the CURRENT extractRows() + reportMap.js parser
// against already-stored raw data — zero SiteLink calls, seconds instead of hours. Use this instead
// of repull-report-month.js / repull-report-all-months.js whenever the fix is purely in our own
// parsing code (the common case) — only fall back to a real re-pull if the raw response itself needs
// to change (e.g. backfilling a report/month that was never pulled at all, or one pulled before this
// raw-storage change landed and so has no raw_response stored yet).
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/reparse-report.js <report> [YYYY-MM]
// Examples:
//   node --env-file=.env scripts/reparse-report.js management        (every stored month)
//   node --env-file=.env scripts/reparse-report.js management 2026-06 (just June 2026)
import { admin } from '../lib/supabaseAdmin.js';
import { REPORTS } from '../lib/reportMap.js';
import { extractRows } from '../lib/sitelink.js';
import { runRebuildPayload } from '../lib/rebuildPayload.js';

const reportKey = process.argv[2];
const monthArg = process.argv[3]; // optional YYYY-MM
if (!reportKey || !REPORTS[reportKey]) {
  console.error('Usage: node scripts/reparse-report.js <report> [YYYY-MM]');
  console.error('Known reports: ' + Object.keys(REPORTS).join(', '));
  process.exit(1);
}
const spec = REPORTS[reportKey];

// CHANGED 8 Jul 2026: this started throwing "canceling statement due to statement timeout" on the
// very first query — fetching every row's raw_response (the full untouched SOAP blob, which can be
// large for wide reports like True Revenue) in one shot got heavy enough to hit Postgres's
// statement_timeout, almost certainly worsened by Supabase's ongoing platform incident (compute
// degradation / capacity constraints in multiple regions since 30 Jun 2026 — status.supabase.com).
// Fix: fetch only id/site_code/month up front (tiny query), then stream each row's raw_response one
// at a time inside the processing loop below — many small queries instead of one big one — with a
// short retry on each, since the failures observed are exactly the transient kind a retry rides out.
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

const PAGE = 500;
async function fetchStoredIds() {
  let all = [];
  for (let from = 0; ; from += PAGE) {
    let data;
    try {
      data = await withRetry(async () => {
        let q = admin.from('raw_report').select('id,site_code,month').eq('report', reportKey).not('raw_response', 'is', null).order('id').range(from, from + PAGE - 1);
        if (monthArg) q = q.eq('month', `${monthArg}-01`);
        const res = await q;
        if (res.error) throw new Error(res.error.message);
        return res.data;
      });
    } catch (e) { console.error(e.message); process.exit(1); }
    all = all.concat(data);
    if (!data || data.length < PAGE) break;
  }
  return all;
}

const idRows = await fetchStoredIds();
console.log(`Found ${idRows.length} stored raw_response row(s) for report=${reportKey}${monthArg ? ` month=${monthArg}` : ' (all months)'}.`);
if (!idRows.length) {
  console.log(`\nNo stored raw_response yet — this report/month hasn't been (re-)pulled since the raw-storage`);
  console.log(`change landed (7 Jul 2026). Reparse can't help until there's at least one real pull to seed it —`);
  console.log(`run the normal repull once (npm run pull, or scripts/repull-report-month.js /`);
  console.log(`repull-report-all-months.js for ${reportKey}), and every pull AFTER that will be reparse-able forever.`);
  process.exit(0);
}

const now = new Date();
let ok = 0, failed = 0;
for (const r of idRows) {
  try {
    const mk = String(r.month).slice(0, 7);
    const [y, m] = mk.split('-').map(Number);
    const startDate = new Date(y, m - 1, 1);
    const isCurrentMonth = y === now.getFullYear() && m === now.getMonth() + 1;
    // FIXED 23 Jul 2026 (production-readiness audit): reparsing must use the SAME effective date
    // window as the live pull that should have created the row. For closed months that means the
    // start of the FOLLOWING day, not midnight at the start of the last day itself, because
    // SiteLink's end bound is exclusive. Otherwise a reparse could keep reinforcing missing-last-day
    // behaviour in any parser that uses start/end to trim raw rows.
    const closedMonthEndExclusive = new Date(y, m, 1);
    const endDate = isCurrentMonth ? now : closedMonthEndExclusive;

    // One small SELECT per row instead of one big one up front (see comment above) — the whole point
    // of the fix, so a heavy/degraded DB fails (and retries) one row at a time, not all-or-nothing.
    const raw_response = await withRetry(async () => {
      const { data, error } = await admin.from('raw_report').select('raw_response').eq('id', r.id).single();
      if (error) throw new Error(error.message);
      return data.raw_response;
    });

    // Same pipeline pullReport() runs at live-pull time — extractRows() picked up fresh here means a
    // future fix to extractRows() itself (e.g. the "biggest table only" bug) gets picked up too, not
    // just fixes to an individual report's parse().
    const extracted = extractRows(raw_response);
    const data = spec.parse(extracted, startDate, endDate, raw_response);
    await withRetry(async () => {
      const { error } = await admin.from('raw_report').update({ data }).eq('id', r.id);
      if (error) throw new Error(error.message);
    });
    ok++;
  } catch (e) {
    failed++;
    console.error(`  ${r.site_code}/${String(r.month).slice(0, 7)}: FAILED — ${e.message}`);
  }
}
console.log(`\nReparsed ${ok}/${idRows.length} row(s) (${failed} failed) — zero SiteLink calls made.`);

// CHANGED 20 Jul 2026: this used to duplicate buildPayload()+the portal_payload upsert inline, with
// no retry — a transient failure here (observed: "canceling statement due to statement timeout",
// most likely just DB load from the 2059 back-to-back updates immediately above) meant losing the
// rebuild even though every row above had already reparsed and saved successfully. Now calls the
// SAME shared runRebuildPayload() the dedicated /api/rebuild-payload cron uses (task #297/#328) —
// one rebuild path instead of two copies of the same 3 lines, and if THIS attempt also fails, the
// already-reparsed data isn't lost: just re-run `npm run rebuild:payload` (or wait for tomorrow's
// 8am cron) to retry the rebuild alone, without redoing any of the reparsing above.
console.log('Rebuilding portal_payload...');
const result = await runRebuildPayload();
if (result.status !== 'ok') {
  console.error(`portal_payload rebuild failed: ${result.message || 'unknown error'}`);
  console.error('The reparse above already succeeded and is saved — just re-run `npm run rebuild:payload` to retry the rebuild alone.');
  process.exit(1);
}
console.log(`Done — portal_payload rebuilt from reparsed data (${result.durationMs}ms).`);
process.exit(0);
