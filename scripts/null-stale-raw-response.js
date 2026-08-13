// One-time (re-runnable) retention cleanup: nulls out raw_report.raw_response for months older than
// a cutoff, leaving the parsed `data` column -- which powers every widget/number in the portal --
// completely untouched. raw_response is "the heaviest field in raw_report" (see lib/buildPayload.js)
// and exists ONLY so scripts/reparse-report.js can replay a parser fix locally without a fresh
// SiteLink pull. For months old enough to be considered stable, that upside no longer justifies
// dragging the blob through every full-history scan -- the Aug 11 historical-slice repair
// (PORTAL_PAYLOAD_BUILD_VERSION in lib/buildPayload.js), full `npm run reparse`/`repull:all` runs, and
// backups all read it, and it's the single biggest driver behind this project's egress overage
// (13 Aug 2026 -- exceed_egress_quota restriction).
//
// Trade-off (Michael's call, 13 Aug 2026): losing raw_response for a nulled month doesn't lose the
// DATA -- closed months' parsed data is stable and keeps working exactly as before. It just means a
// future parser fix for that specific old month needs a real SiteLink re-pull
// (scripts/repull-report-month.js) instead of an instant local replay. Chose a 12-month retention
// window: covers the window almost every real reparse fix has actually landed in, while still
// clearing the bulk of a data set that goes back to 2021+ per reportMap.js/backfill.js.
//
// Safe by default -- running with no flags only COUNTS what would change. Nothing is modified unless
// you pass --execute.
//   node --env-file=.env scripts/null-stale-raw-response.js            -> dry run (count only)
//   node --env-file=.env scripts/null-stale-raw-response.js --execute  -> actually nulls rows
//   CUTOFF_MONTHS=6 node --env-file=.env scripts/null-stale-raw-response.js --execute
//
// Same pattern as reparse-report.js: fetch a small id-only page first, then act row-by-row with
// retries, so a heavy/degraded DB fails (and retries) one row at a time instead of all-or-nothing --
// raw_report is exactly the table that's repeatedly hit statement timeouts on bulk operations.
import { admin } from '../lib/supabaseAdmin.js';
import { reportingCurrentMonthStart } from '../lib/reportingPeriod.js';

const CUTOFF_MONTHS = Number(process.env.CUTOFF_MONTHS || 12);
const EXECUTE = process.argv.includes('--execute');

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

const curStart = reportingCurrentMonthStart(new Date());
const cutoff = new Date(curStart.getFullYear(), curStart.getMonth() - CUTOFF_MONTHS, 1);
const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-01`;

console.log(`Cutoff: keeping raw_response for ${cutoffKey} and newer; nulling anything older (CUTOFF_MONTHS=${CUTOFF_MONTHS}).`);
console.log(EXECUTE ? 'Mode: EXECUTE -- rows will be modified.' : 'Mode: DRY RUN -- no changes will be made (pass --execute to actually null rows).');

const PAGE = 500;
async function fetchStaleIds() {
  let all = [];
  for (let from = 0; ; from += PAGE) {
    const rows = await withRetry(async () => {
      const { data, error } = await admin
        .from('raw_report')
        .select('id,report,site_code,month')
        .not('raw_response', 'is', null)
        .lt('month', cutoffKey)
        .order('id')
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      return data || [];
    });
    all = all.concat(rows);
    if (rows.length < PAGE) break;
  }
  return all;
}

const staleRows = await fetchStaleIds();
console.log(`Found ${staleRows.length} row(s) with a stored raw_response older than ${cutoffKey}.`);
if (!staleRows.length) {
  console.log('Nothing to do.');
  process.exit(0);
}

const byReport = {};
for (const r of staleRows) byReport[r.report] = (byReport[r.report] || 0) + 1;
console.log('By report:', JSON.stringify(byReport, null, 2));

if (!EXECUTE) {
  console.log('\nDry run only -- re-run with --execute to actually null these rows.');
  process.exit(0);
}

let ok = 0, failed = 0;
for (const r of staleRows) {
  try {
    await withRetry(async () => {
      const { error } = await admin.from('raw_report').update({ raw_response: null }).eq('id', r.id);
      if (error) throw new Error(error.message);
    });
    ok++;
  } catch (e) {
    failed++;
    console.error(`  id=${r.id} ${r.report}/${r.site_code}/${String(r.month).slice(0, 7)}: FAILED -- ${e.message}`);
  }
}
console.log(`\nNulled raw_response on ${ok}/${staleRows.length} row(s) (${failed} failed). Parsed data columns untouched -- portal display is unaffected.`);
process.exit(failed ? 1 : 0);
