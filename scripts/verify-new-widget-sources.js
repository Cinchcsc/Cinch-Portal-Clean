// Verification pass (9 Jul 2026) before building the new widgets Michael scoped (Discount Summary
// page, Occupancy by Floor %, Move-in Variance): checks the assumptions those builds would rest on,
// rather than trusting guessed method names or a single 3-row sample.
//   1. Is "DiscountSummary" / "UnitStatus" actually a callable SOAP method on this WSDL, or are they
//      UI-export-only? Neither name is documented in either uploaded API PDF — callReport() throws a
//      clear error listing every real Async method on the WSDL if the guess is wrong, so this settles
//      it definitively instead of assuming.
//   2. Is OccupancyStatistics (already pulled every month) ALSO a hidden multi-table response like
//      ManagementSummary turned out to be — possibly with a per-unit/floor table already inside a
//      report we don't need to add at all?
//   3. Full VarFromStdRate bucket list (previous dump only showed 3 of 5 rows).
// Run: cd cinch-portal-clean && node --env-file=.env scripts/verify-new-widget-sources.js [siteCode] [YYYY-MM]
import { callReport, extractNamedTable } from '../lib/sitelink.js';

const siteCode = process.argv[2] || 'L001';
const monthArg = process.argv[3];
let start, end;
if (monthArg) {
  const [y, m] = monthArg.split('-').map(Number);
  start = new Date(y, m - 1, 1);
  const now = new Date();
  const fullMonthEnd = new Date(y, m, 0);
  end = (y === now.getFullYear() && m === now.getMonth() + 1 && fullMonthEnd > now) ? now : fullMonthEnd;
} else {
  start = new Date(new Date().getFullYear(), new Date().getMonth(), 1); end = new Date();
}
console.log(`Site ${siteCode}, ${start.toISOString().slice(0,10)} to ${end.toISOString().slice(0,10)}\n`);

console.log('=== 1a. Is "DiscountSummary" a real SOAP method? ===');
try {
  const { rows } = await callReport('DiscountSummary', siteCode, start, end);
  console.log(`YES — callable. ${rows.length} rows. Sample: ${JSON.stringify(rows[0])}`);
} catch (e) { console.log('NO — ' + e.message.split('Available:')[0].trim()); }

console.log('\n=== 1b. Is "UnitStatus" a real SOAP method? ===');
try {
  const { rows } = await callReport('UnitStatus', siteCode, start, end);
  console.log(`YES — callable. ${rows.length} rows. Sample: ${JSON.stringify(rows[0])}`);
} catch (e) { console.log('NO — ' + e.message.split('Available:')[0].trim()); }

console.log('\n=== 1c. Full list of every real Async method on the WSDL matching discount/concession/unit ===');
try {
  await callReport('__NoSuchMethod__', siteCode, start, end);
} catch (e) {
  const list = e.message.split('Available:')[1] || '';
  const names = list.split(',').map(s => s.trim().replace(/Async$/, '')).filter(Boolean);
  console.log(names.filter(n => /discount|concession|unit/i.test(n)).join('\n') || '(none matched — full list below)');
  if (!names.some(n => /discount|concession|unit/i.test(n))) console.log(names.join('\n'));
}

console.log('\n=== 2. Is OccupancyStatistics (already pulled) hiding a per-unit/floor table? ===');
const { raw: occRaw } = await callReport('OccupancyStatistics', siteCode, start, end);
let diff = null;
(function find(node) {
  if (!node || typeof node !== 'object' || diff) return;
  for (const [k, v] of Object.entries(node)) {
    if (diff) return;
    if (/diffgram/i.test(k) && v && typeof v === 'object') { diff = v; return; }
    if (v && typeof v === 'object') find(v);
  }
})(occRaw);
const occTables = [];
(function walk(node, path) {
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') occTables.push({ name: k, count: v.length, keys: Object.keys(v[0]).filter(x => x !== 'attributes') });
    else if (v && typeof v === 'object') walk(v, `${path}.${k}`);
  }
})(diff || occRaw, 'root');
console.log(`${occTables.length} table(s) found:`);
for (const t of occTables) console.log(`  ${t.name} (${t.count} rows) — keys: ${t.keys.join(', ')}`);

console.log('\n=== 3. Full VarFromStdRate bucket list (ManagementSummary) ===');
const { raw: mgmtRaw } = await callReport('ManagementSummary', siteCode, start, end);
const varRows = extractNamedTable(mgmtRaw, 'VarFromStdRate');
for (const r of varRows) console.log('  ' + JSON.stringify(r));

process.exit(0);
