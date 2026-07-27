// PROBE (27 Jul 2026), READ-ONLY — live-verification sweep after today's #426 fix + reparse found
// something surprising: the portal now shows portfolio-wide insured_new_customers.count = 18 for
// July 2026 (28 of 29 sites reading exactly 0), vs June 2026's known baseline of ~900+ portfolio-wide
// (task #426's own stability probe). A ~50x drop between a full month and a 26-day-in partial month
// is not plausible on its own -- this checks whether that's a real, currently-live bug (e.g. in how
// the CURRENT month's endDate gets passed at reparse time) or genuinely correct (e.g. insurance
// sign-up lags weeks behind move-in, so July's movers haven't shown up in InsuranceRoll yet).
//
// For one site (default Bicester), dumps: every stored row's dMovedIn + iActive, re-run today's exact
// parser logic with an explicit, freshly-computed [monthStart, now] window, and compares that against
// what's currently saved in raw_report.data. Zero SiteLink calls, zero writes.
//
// Run:  node --env-file=.env scripts/probe-insurance-roll-julycount-check.js [siteCode] [YYYY-MM]
import { admin } from '../lib/supabaseAdmin.js';
import { extractRows } from '../lib/sitelink.js';
import { REPORTS } from '../lib/reportMap.js';

const site = process.argv[2] || 'L001';
const monthArg = process.argv[3];
const now = new Date();
const monthKey = monthArg ? `${monthArg}-01` : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
const [y, m] = monthKey.split('-').map(Number);
const startDate = new Date(y, m - 1, 1);
const isCurrentMonth = y === now.getFullYear() && m === now.getMonth() + 1;
const endDate = isCurrentMonth ? now : new Date(y, m, 1);   // same convention reparse-report.js uses

const { data: row, error } = await admin
  .from('raw_report').select('id,pulled_at,raw_response,data')
  .eq('site_code', site).eq('month', monthKey).eq('report', 'insurance_roll')
  .order('id', { ascending: false }).limit(1).maybeSingle();
if (error) { console.error('Fetch error:', error.message); process.exit(1); }
if (!row) { console.log(`No insurance_roll row for ${site}/${monthKey}.`); process.exit(0); }

console.log(`${site} / ${monthKey.slice(0, 7)} — raw_report id=${row.id}, pulled_at=${row.pulled_at}`);
console.log(`Window used for this check: ${startDate.toDateString()} to ${endDate.toDateString()} (isCurrentMonth=${isCurrentMonth})`);
console.log(`Currently stored data.insured_new_customers: ${JSON.stringify(row.data && row.data.insured_new_customers)}\n`);

const rows = extractRows(row.raw_response);
console.log(`Total rows in raw_response: ${rows.length}`);

// Re-run TODAY's exact parser, fresh, right now, against the SAME raw_response.
const fresh = REPORTS.insurance_roll.parse(rows, startDate, endDate);
console.log(`Fresh re-parse (this exact moment, same code as production) => ${JSON.stringify(fresh)}\n`);

// Dump every row's dMovedIn (raw + parsed) and iActive, sorted by dMovedIn, so it's visible directly
// whether July dates are actually present on this report at all.
const sample = rows
  .map((r) => ({ dMovedIn: r.dMovedIn, iActive: r.iActive, dcPremium: r.dcPremium }))
  .filter((r) => r.dMovedIn)
  .sort((a, b) => new Date(b.dMovedIn) - new Date(a.dMovedIn))
  .slice(0, 15);
console.log(`15 most recent dMovedIn dates on this report (any year):`);
for (const r of sample) console.log(' ', JSON.stringify(r));

const inJuly = rows.filter((r) => {
  if (!r.dMovedIn) return false;
  const d = new Date(r.dMovedIn);
  return !Number.isNaN(d.getTime()) && d >= startDate && d <= endDate;
});
console.log(`\nRows whose dMovedIn falls inside [${startDate.toDateString()}, ${endDate.toDateString()}]: ${inJuly.length}`);
for (const r of inJuly.slice(0, 10)) console.log(' ', JSON.stringify({ dMovedIn: r.dMovedIn, iActive: r.iActive, dcPremium: r.dcPremium }));
process.exit(0);
