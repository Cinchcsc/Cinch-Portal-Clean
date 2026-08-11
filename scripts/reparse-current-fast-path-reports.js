import { admin } from '../lib/supabaseAdmin.js';
import { REPORTS } from '../lib/reportMap.js';
import { lastCompleteDay, reportingCurrentMonthStart } from '../lib/reportingPeriod.js';
import { extractRows } from '../lib/sitelink.js';
import { runRebuildPayload } from '../lib/rebuildPayload.js';

// Focus on the current-month report families the fast live payload path was proven to diverge on in
// direct source-vs-live parity checks. Keeping this list tight minimizes DB write load during repair
// while still covering every current-month report family we've confirmed can leak stale parsed JSON
// into visible widgets.
const DEFAULT_REPORTS = ['scheduled_outs', 'insurance_activity', 'insurance_roll', 'marketing'];

function parseMonthArg(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}$/.test(text)) return null;
  const month = Number(text.slice(5, 7));
  return month >= 1 && month <= 12 ? text : null;
}

async function withRetry(fn, attempts = 3, delayMs = 2000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

const monthArg = parseMonthArg(process.argv[2]) || `${reportingCurrentMonthStart(new Date()).getFullYear()}-${String(reportingCurrentMonthStart(new Date()).getMonth() + 1).padStart(2, '0')}`;
const reportKeys = DEFAULT_REPORTS.filter((key) => REPORTS[key]);
const monthKey = `${monthArg}-01`;
const [year, month] = monthArg.split('-').map(Number);
const startDate = new Date(year, month - 1, 1);
const isCurrentMonth = monthArg === `${reportingCurrentMonthStart(new Date()).getFullYear()}-${String(reportingCurrentMonthStart(new Date()).getMonth() + 1).padStart(2, '0')}`;
const endDate = isCurrentMonth ? lastCompleteDay(new Date()) : new Date(year, month, 1);

console.log(`Reparsing current fast-path reports for ${monthArg}: ${reportKeys.join(', ')}`);
console.log(`Visible window: ${startDate.toISOString().slice(0, 10)} -> ${isCurrentMonth ? endDate.toISOString().slice(0, 10) : new Date(endDate.getTime() - 86400000).toISOString().slice(0, 10)}`);

const { data, error } = await withRetry(async () => {
  const result = await admin
    .from('raw_report')
    .select('id,site_code,month,report,raw_response')
    .eq('month', monthKey)
    .in('report', reportKeys)
    .not('raw_response', 'is', null)
    .order('report')
    .order('site_code');
  if (result.error) throw new Error(result.error.message);
  return result;
});
if (error) throw error;

console.log(`Found ${data?.length || 0} row(s).`);
let ok = 0;
let failed = 0;
for (const row of data || []) {
  try {
    const spec = REPORTS[row.report];
    const reparsed = spec.parse(extractRows(row.raw_response), startDate, endDate, row.raw_response);
    await withRetry(async () => {
      const result = await admin.from('raw_report').update({ data: reparsed }).eq('id', row.id);
      if (result.error) throw new Error(result.error.message);
      return result;
    });
    ok++;
    if (ok % 25 === 0) console.log(`  reparsed ${ok}/${data.length}...`);
  } catch (err) {
    failed++;
    console.error(`  FAILED ${row.report} ${row.site_code}: ${err.message}`);
  }
}

console.log(`Reparsed ${ok}/${data?.length || 0} row(s); ${failed} failed.`);
console.log('Rebuilding portal payload...');
const rebuild = await runRebuildPayload({ triggerLabel: `reparse-current-fast-path:${monthArg}` });
console.log(JSON.stringify({ rebuild }, null, 2));

if (failed || rebuild.status !== 'ok') process.exit(1);
process.exit(0);
