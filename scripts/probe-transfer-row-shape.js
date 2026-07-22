// PROBE (22 Jul 2026), task #308/#403/#404/#405 — probe-realrate-nocredit-all-sites.js's biggest
// finding: Newbury hit an EXACT £0.00 gap using Rent alone (no Credit, no Discounts) -- strong
// evidence Credit was never supposed to be subtracted at all. But 24/25 sites still undershoot
// somewhat even with Rent alone, which points at the AREA rewind, not the revenue formula.
//
// Suspect: probe-realrate-rewind-occupied-area.js's netSince() computes, per MoveInsAndMoveOuts row:
//   sign = (MoveIn?1:0) - (MoveOut?1:0)
//   area = MoveIn ? MovedInArea : MovedOutArea
//   netArea += sign * area
// IF a same-site unit TRANSFER (upsize/downsize) is recorded as ONE row with BOTH MoveIn=true AND
// MoveOut=true, then sign = 1-1 = 0, so that row contributes ZERO net area change -- even though the
// true area change should be (MovedInArea - MovedOutArea) whenever the old and new units are different
// sizes. That would silently drop real area deltas for every transfer to a different-sized unit,
// making rewound area too LARGE (since it's missing the "shrink" from downsizes, or missing the "grow"
// from upsizes -- either way, biased toward overstating occupied area), which understates Real Rate --
// exactly the one-directional bias seen. Sites with more transfer activity would show a bigger gap,
// sites with little/none (maybe Newbury) would show ~zero -- consistent with what was just found.
//
// This dumps every row where Transfer=true in the June 30 -> today window for a few sites with the
// largest residual gaps, to see the ACTUAL MoveIn/MoveOut/MovedInArea/MovedOutArea values on those
// rows -- confirming or ruling out this specific mechanism before changing any code.
//
// Run:  node --env-file=.env scripts/probe-transfer-row-shape.js
import { callReport } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? ''));
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };

const now = new Date();
const windowStart = new Date(2026, 6, 1); // 1 Jul (day after 30 Jun month-end)

// A spread: Mitcham/Enfield/Sittingbourne (large residual gap under Rent-alone) vs Newbury (exact hit).
const SITES = ['L010', 'L008', 'L011', 'L009'];

for (const code of SITES) {
  console.log(`\n${'='.repeat(100)}\n${code}\n${'='.repeat(100)}`);
  const { rows } = await callReport('MoveInsAndMoveOuts', code, windowStart, now);
  const transferRows = rows.filter((r) => yes(r.Transfer));
  console.log(`Total rows: ${rows.length}, Transfer=true rows: ${transferRows.length}`);
  let bothFlags = 0, onlyIn = 0, onlyOut = 0, neither = 0, sameArea = 0, diffArea = 0;
  for (const r of transferRows) {
    const mi = yes(r.MoveIn), mo = yes(r.MoveOut);
    if (mi && mo) bothFlags++; else if (mi) onlyIn++; else if (mo) onlyOut++; else neither++;
    const inArea = num(r.MovedInArea), outArea = num(r.MovedOutArea);
    if (mi && mo) { if (Math.abs(inArea - outArea) < 0.01) sameArea++; else diffArea++; }
  }
  console.log(`  Transfer rows with BOTH MoveIn+MoveOut true: ${bothFlags} (of which same-area: ${sameArea}, different-area: ${diffArea})`);
  console.log(`  Transfer rows with only MoveIn: ${onlyIn}, only MoveOut: ${onlyOut}, neither flag: ${neither}`);
  if (transferRows.length) {
    console.log(`  First 5 transfer rows (UnitName, MoveIn, MoveOut, MovedInArea, MovedOutArea, MoveDate):`);
    transferRows.slice(0, 5).forEach((r) => console.log(`    ${r.UnitName}: MoveIn=${r.MoveIn} MoveOut=${r.MoveOut} MovedInArea=${r.MovedInArea} MovedOutArea=${r.MovedOutArea} MoveDate=${r.MoveDate}`));
  }
}

console.log(`\n${'='.repeat(100)}\nIf many rows show BOTH MoveIn+MoveOut true with DIFFERENT MovedInArea vs\nMovedOutArea, that confirms the bug: those rows currently contribute ZERO to\nnet area (sign cancels to 0) when they should contribute (MovedInArea -\nMovedOutArea). Fix: for rows with both flags, add (MovedInArea - MovedOutArea)\ndirectly instead of using the cancel-to-0 sign logic.\n${'='.repeat(100)}`);
process.exit(0);
