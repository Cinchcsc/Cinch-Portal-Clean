// PROBE (23 Jul 2026), task #406 — probe-mio-table-selection.js found NO array-shaped table
// anywhere in the raw MoveInsAndMoveOuts response for Abingdon/22 Jul, even though a real move-in
// definitely exists (confirmed via Michael's native SiteLink export + probe-abingdon-chat-events.js).
// The only array found was schema metadata (3 rows), not data.
//
// Working theory: with exactly ONE real data row, the XML-to-JS conversion (node-soap, xml2js under
// the hood) very likely does NOT wrap a single repeated element in an array -- it produces a single
// PLAIN OBJECT instead. extractRows()/extractNamedTable() (lib/sitelink.js) both ONLY ever look for
// `Array.isArray(v)`, so a lone object row would be invisible to both, everywhere in the codebase,
// not just here -- this would silently return 0 rows any time a report call happens to match exactly
// ONE real record, portfolio-wide, for any report, any time. That's a much bigger finding than one
// missing move-in if true.
//
// This dumps every OBJECT (not just arrays) in the diffgram scope that has MoveIn/MoveOut/MoveDate-
// shaped keys, array or not, to find exactly where the real row is sitting.
//
// Run:  node --env-file=.env scripts/probe-mio-single-row-shape.js
import { callReport } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const SITE = 'L029';
const start = new Date(2026, 6, 22);
const end = new Date(2026, 6, 23);

const { raw } = await callReport('MoveInsAndMoveOuts', SITE, start, end);

console.log(`${'='.repeat(95)}\nFull diffgram-scoped structure, ${SITE}, 22 Jul (soapEnd=23 Jul)\n${'='.repeat(95)}`);

// Same diffgram-finder as extractRows(), reused so this is scoped identically.
let diff = null;
(function find(node) {
  if (!node || typeof node !== 'object' || diff) return;
  for (const [k, v] of Object.entries(node)) {
    if (diff) return;
    if (/diffgram/i.test(k) && v && typeof v === 'object') { diff = v; return; }
    if (v && typeof v === 'object') find(v);
  }
})(raw);
console.log(`diffgram found: ${!!diff}`);
const scope = diff || raw;

const seen = new Set();
const moveEventKeys = ['MoveIn', 'MoveOut', 'MoveDate', 'Transfer'];
(function walk(node, path) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  for (const [k, v] of Object.entries(node)) {
    if (Array.isArray(v)) {
      console.log(`  [ARRAY] ${path}${k}: length=${v.length}`);
      v.forEach((item, i) => walk(item, `${path}${k}[${i}].`));
    } else if (v && typeof v === 'object') {
      const keys = Object.keys(v.attributes || v);
      const looksLikeMoveRow = moveEventKeys.some((mk) => keys.includes(mk));
      console.log(`  [OBJECT]${looksLikeMoveRow ? ' <-- HAS MoveIn/MoveOut/MoveDate/Transfer keys!' : ''} ${path}${k}: keys=[${keys.slice(0, 12).join(',')}${keys.length > 12 ? ',...' : ''}]`);
      if (looksLikeMoveRow) console.log(`      full: ${JSON.stringify(v.attributes || v)}`);
      walk(v, `${path}${k}.`);
    }
  }
})(scope, '');

console.log(`\n${'='.repeat(95)}\nIf an [OBJECT] (not [ARRAY]) is flagged with MoveIn/MoveOut/MoveDate keys, that\nconfirms: a single real row parses as a plain object, not a 1-element array, and\nextractRows()/extractNamedTable() both miss it because they only ever check\nArray.isArray(v). Fix: also accept a single plain object shaped like a row,\nnormalizing it to a 1-element array, in both functions.\n${'='.repeat(95)}`);
process.exit(0);
