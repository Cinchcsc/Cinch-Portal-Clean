// PROBE (23 Jul 2026), task #406 — follow-up to probe-mio-single-row-shape.js, which had its own bug:
// its `keys = Object.keys(v.attributes || v)` discarded an object's OWN scalar fields whenever an
// `attributes` sub-key was present, and its walker only ever printed nested objects/arrays, never
// leaf string/number values -- so a field like `MoveIn: '1'` sitting as a plain property could never
// have been shown, even if present. That run DID show something useful despite the bug: the row-shaped
// key `NewDataSet.UnitMoveInsAndMoveOuts` is a SINGULAR object, not an array (same for Totals/Sites) --
// consistent with the "single row parses as a bare object, not a 1-element array" hypothesis, but not
// yet proof, since we never actually saw its field values.
//
// This walks the same diffgram scope but: (a) prints EVERY own key of every object encountered,
// scalar or not, (b) treats `attributes` as XML bookkeeping only (diffgr:id, msdata:rowOrder) and
// reports it separately rather than letting it mask the object's real sibling fields, (c) explicitly
// prints the full field set (JSON) of any object whose OWN keys include MoveIn/MoveOut/MoveDate/
// Transfer/TenantName/UnitID -- so we can see actual values, not just key names this time.
//
// Run:  node --env-file=.env scripts/probe-mio-single-row-fields.js
import { callReport } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const SITE = 'L029';
const start = new Date(2026, 6, 22);
const end = new Date(2026, 6, 23);

const { raw } = await callReport('MoveInsAndMoveOuts', SITE, start, end);

console.log(`${'='.repeat(95)}\nFull field dump, ${SITE}, 22 Jul (soapEnd=23 Jul)\n${'='.repeat(95)}`);

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

const ROW_FIELD_HINTS = ['MoveIn', 'MoveOut', 'MoveDate', 'Transfer', 'TenantName', 'UnitID', 'MovedInArea', 'MovedOutArea', 'UnitSize'];
const seen = new Set();
(function walk(node, path) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  for (const [k, v] of Object.entries(node)) {
    if (Array.isArray(v)) {
      console.log(`  [ARRAY] ${path}${k}: length=${v.length}`);
      v.forEach((item, i) => walk(item, `${path}${k}[${i}].`));
    } else if (v && typeof v === 'object') {
      const ownKeys = Object.keys(v); // includes 'attributes' as a key name, but NOT flattened into it
      console.log(`  [OBJECT] ${path}${k}: ownKeys=[${ownKeys.join(',')}]`);
      const looksLikeRow = ROW_FIELD_HINTS.some((f) => ownKeys.includes(f));
      if (looksLikeRow) {
        const plain = {};
        for (const kk of ownKeys) if (kk !== 'attributes') plain[kk] = v[kk];
        console.log(`      *** ROW FIELDS FOUND *** ${path}${k} = ${JSON.stringify(plain)}`);
      }
      walk(v, `${path}${k}.`);
    } else {
      // leaf scalar -- print every one, not just flagged names, since this is the exact thing v1 missed
      console.log(`  [LEAF]  ${path}${k} = ${JSON.stringify(v)}`);
    }
  }
})(scope, '');

console.log(`\n${'='.repeat(95)}\nLook for a "*** ROW FIELDS FOUND ***" line under NewDataSet.UnitMoveInsAndMoveOuts.\nIf its MoveIn/MoveDate/TenantName values match the known Boyles 125sqft move-in,\nthat CONFIRMS: single-row responses parse as a bare object, invisible to both\nextractRows() and extractNamedTable() since they only ever check Array.isArray(v).\n${'='.repeat(95)}`);
process.exit(0);
