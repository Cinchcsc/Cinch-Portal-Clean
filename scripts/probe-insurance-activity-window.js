// PROBE (17 Jul 2026 original; REWRITTEN 24 Jul 2026, task #425) — read-only, zero SiteLink calls,
// reuses already-stored raw_response (reparse-report.js's pattern).
//
// ORIGINAL VERSION of this script used extractRows() (a size-based table pick) and naive JS-truthy
// checks (`if (row.sNewPolicy) ...`) — exactly the two bugs that were root-caused and fixed in
// lib/reportMap.js's insurance_activity parser on 17 Jul 2026 (extractNamedTable('Insur_InsuranceActivity')
// by NAME, and yes() instead of a truthy check on a Y/N-string field). Michael re-ran the OLD version of
// this script on 24 Jul and got 349/349/349 (Jun) and 327/327/327 (Jul) — reproducing the exact
// degenerate "every row = both new AND cancelled" pattern the 17 Jul fix was supposed to have killed.
// That's NOT evidence production is still broken — it's evidence this PROBE script itself was never
// updated after the fix, so it was still testing the old, already-superseded extraction logic. This
// version fixes the probe to match production exactly, and ALSO directly answers the still-open
// "NOT YET CONFIRMED" date-window question from that same 17 Jul comment (lib/reportMap.js ~line
// 584-589): does Insur_InsuranceActivity return rows outside the requested month at all? We now know
// the column list (captured from Michael's run): dActivity, dPaidThru, dMovedIn, dStart, sAnniv are all
// candidate per-row date fields. dActivity ("date of this activity/event") is the best-fit candidate for
// "when did this new-policy/cancellation event actually happen" — this script tests directly against
// stored data whether using it as a client-side filter would change anything.
//
// Run:  node --env-file=.env scripts/probe-insurance-activity-window.js [SITE_CODE] [all]
// Default site: L001 (Bicester). Pass a second arg of 'all' to scan every stored site instead.
import { admin } from '../lib/supabaseAdmin.js';
import { extractNamedTable } from '../lib/sitelink.js';

const site = process.argv[2] || 'L001';
const scanAll = process.argv[3] === 'all';

const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? ''));
const dayOnly = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const inWindow = (dateVal, start, end) => {
  if (!dateVal) return false;
  const d = new Date(dateVal);
  if (Number.isNaN(d.getTime())) return false;
  const day = dayOnly(d);
  return day >= dayOnly(start) && day <= dayOnly(end);
};

async function fetchStoredMonths(siteCode) {
  let q = admin.from('raw_report').select('id,site_code,month,raw_response').eq('report', 'insurance_activity').not('raw_response', 'is', null).order('month');
  if (!scanAll) q = q.eq('site_code', siteCode);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

const rows = await fetchStoredMonths(site);
console.log(`Found ${rows.length} stored insurance_activity raw_response row(s)${scanAll ? ' (all sites)' : ` for ${site}`}.`);
if (!rows.length) {
  console.log('\nNothing stored yet for this report/site — run npm run pull (or a targeted repull for insurance_activity) first.');
  process.exit(0);
}

console.log('\nsite   month      table_rows  newPol(FIXED)  cancelled(FIXED)  outside_window(dActivity)  outside_window(dPaidThru)');
console.log('-'.repeat(105));

const summary = [];
for (const r of rows) {
  const monthStart = new Date(r.month);
  const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
  const activityRows = extractNamedTable(r.raw_response, 'Insur_InsuranceActivity');
  let newPol = 0, cancelled = 0, outsideActivity = 0, outsidePaidThru = 0, haveActivityDate = 0, havePaidThruDate = 0;
  for (const row of activityRows) {
    if (yes(row.sNewPolicy)) newPol++;
    if (yes(row.sCancelledPolicy) || yes(row.bCancelled)) cancelled++;
    if (row.dActivity) { haveActivityDate++; if (!inWindow(row.dActivity, monthStart, monthEnd)) outsideActivity++; }
    if (row.dPaidThru) { havePaidThruDate++; if (!inWindow(row.dPaidThru, monthStart, monthEnd)) outsidePaidThru++; }
  }
  const monthLabel = String(r.month).slice(0, 7);
  summary.push({ site: r.site_code, month: monthLabel, rowCount: activityRows.length, newPol, cancelled, outsideActivity, haveActivityDate, outsidePaidThru, havePaidThruDate });
  console.log(
    r.site_code.padEnd(6), monthLabel.padEnd(10),
    String(activityRows.length).padStart(10), '  ',
    String(newPol).padStart(13), '  ',
    String(cancelled).padStart(16), '  ',
    `${outsideActivity}/${haveActivityDate}`.padEnd(25),
    `${outsidePaidThru}/${havePaidThruDate}`,
  );
}

console.log(`\n${'='.repeat(105)}`);
console.log('READING THIS:');
console.log('- newPol/cancelled columns now use the CURRENT (fixed) production logic — if these are no');
console.log('  longer identical to each other and to table_rows, the 17 Jul fix is confirmed still holding.');
console.log('- table_rows genuinely differing month to month for the same site is itself evidence SiteLink');
console.log('  IS scoping this report by the requested date range (a report that ignores the date param');
console.log('  entirely — like ReservationList before its fix — would return the SAME row count every time).');
console.log('- outside_window(dActivity)/(dPaidThru) show "N outside the requested month / N rows that had');
console.log('  this date field populated at all". A nonzero outside-count means some rows in the response');
console.log('  genuinely fall outside the month being asked for — i.e. a real leak that a client-side filter');
console.log('  (mirroring insurance_roll\'s dMovedIn pattern) would need to catch, exactly like lead_funnel\'s');
console.log('  dPlaced fix. All zero (or fields never populated) means no further client-side filter is');
console.log('  needed for this report — the date-window question can be treated as closed.');
process.exit(0);
