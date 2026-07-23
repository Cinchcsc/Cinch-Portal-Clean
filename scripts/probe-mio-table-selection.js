// PROBE (23 Jul 2026), task #406 — the Daily Snapshot fix (commit d1b6310) still shows Abingdon
// (L029) at 0 move-ins for 22 Jul, even after a fresh pull run AFTER confirming (via Michael's own
// native SiteLink export, InquiryTracking_20260722_20260722_055718.xlsx, and probe-abingdon-chat-
// events.js) that a real 125 sqft move-in (Boyles, Casper, MoveDate=2026-07-22T16:59:15) genuinely
// exists. That rules out the "data wasn't in SiteLink yet" timing theory tested a moment ago.
//
// Suspect: the SAME "extractRows() keeps whichever table is numerically LARGEST" bug already found
// and fixed four separate times in this codebase (management/insurance_activity, lead_funnel,
// true_revenue — see reportMap.js's own comments) may also apply to MoveInsAndMoveOuts. All of this
// investigation's earlier MoveInsAndMoveOuts calls (the area-rewind probes, the endOf() bug check)
// used WIDE date ranges (full months) with plenty of real move event rows, so extractRows()'s
// size-based pick likely landed on the right table by coincidence every time. A single EXACT DAY
// query for a smaller site, with as few as ONE real move event, is exactly the low-volume case where
// some OTHER table in the same multi-table SOAP response could out-size the real one — the identical
// failure mode as the other four bugs, just never triggered until the Daily Snapshot's per-day
// per-site query shape.
//
// This calls MoveInsAndMoveOuts directly for L029, 22-23 Jul (matching pullSnapshot.js's own widened
// SOAP bound), and dumps EVERY table name + row count in the raw response, plus what extractRows()
// actually picked vs. what a specific move-event-shaped table would look like.
//
// Run:  node --env-file=.env scripts/probe-mio-table-selection.js
import { callReport, extractRows } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const SITE = 'L029';
const start = new Date(2026, 6, 22);
const end = new Date(2026, 6, 23); // matches pullSnapshot.js's soapEndBound() exactly

console.log(`${'='.repeat(95)}\nMoveInsAndMoveOuts raw response shape, ${SITE}, 22 Jul (soapEnd=23 Jul)\n${'='.repeat(95)}`);
const { rows, raw } = await callReport('MoveInsAndMoveOuts', SITE, start, end);

console.log(`\nextractRows() (the 'biggest table wins' picker) returned: ${rows.length} row(s)`);
if (rows.length) {
  console.log('Sample keys of what it picked:', Object.keys(rows[0]).slice(0, 10).join(', '));
  console.log('First row:', JSON.stringify(rows[0]));
}

console.log(`\n--- Every table found anywhere in the raw SOAP response ---`);
const seen = new Set();
(function walk(node, path) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  for (const [k, v] of Object.entries(node)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
      const sample = v[0].attributes ? { ...v[0].attributes, ...v[0] } : v[0];
      const looksLikeMoveEvent = 'MoveIn' in sample || 'MoveOut' in sample || 'MoveDate' in sample;
      console.log(`  ${path}${k}: ${v.length} row(s)${looksLikeMoveEvent ? '  <-- HAS MoveIn/MoveOut/MoveDate fields' : ''}`);
      if (looksLikeMoveEvent) console.log(`      sample: ${JSON.stringify(sample).slice(0, 300)}`);
    } else if (v && typeof v === 'object') {
      walk(v, `${path}${k}.`);
    }
  }
})(raw, '');

console.log(`\n${'='.repeat(95)}\nIf extractRows()'s ${rows.length}-row pick does NOT have MoveIn/MoveOut/MoveDate fields,\nor is a different row count than a table flagged above, that confirms the same\n'biggest table wins' bug already fixed 4 times elsewhere -- fix here is the same\npattern: extractNamedTable(raw, '<the flagged table name>') instead of extractRows().\n${'='.repeat(95)}`);
process.exit(0);
