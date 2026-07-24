// PROBE (24 Jul 2026), task #308/#404 follow-up to probe-realrate-rewound-area-all-sites.js.
//
// That script showed the rewound-occupied-area denominator (live today, walked back to June 30 via
// MoveInsAndMoveOuts' real dated net-move events) FIXED 6 of the 7 known >£1-miss outlier sites —
// Chippenham, Brighton, Sittingbourne, Sidcup, Swindon, and Exeter all landed within £0.3-0.7 of
// target, down from £1.05-1.59 misses under the frozen June rent_roll snapshot's area. Portfolio-wide:
// avg|gap| dropped £0.78 -> £0.51, within-£1 count rose 18/25 -> 24/25.
//
// Enfield (L008) is the ONE exception, and it didn't just fail to improve — it flipped sign and got
// slightly WORSE: frozen-area gap was +£1.05 (overshoot), rewound-area gap is -£1.10 (undershoot).
// The area swing driving that is also the largest of any site by a wide margin: rewound area
// (15,652 sqft/180u) vs frozen area (13,923 sqft/170u) — a difference of +1,729 sqft / +10 units,
// vs. the next-largest swing anywhere being Exeter's -1,120 sqft/-17u (which HELPED, not hurt).
//
// Two live possibilities: (a) Enfield genuinely had unusually heavy, lumpy tenant turnover from 1 Jul
// through today that the rewind is correctly capturing, and the frozen June snapshot's area was simply
// wrong in the other direction at this site; or (b) something in this specific site's July-to-today
// MoveInsAndMoveOuts window is an artifact — e.g. moves clustered suspiciously on one date (import/
// backfill signature rather than organic churn), a duplicated tenant/unit entry, or one implausibly
// large single move dominating the net figure.
//
// This dumps every individual MoveInsAndMoveOuts row for Enfield in the exact rewind window (1 Jul ->
// today), grouped by date, so the shape of what's driving the +1,729 sqft swing is directly visible.
// Uses the same extractNamedTable(raw, 'UnitMoveInsAndMoveOuts')-based extraction as production's
// move_ins_outs parser (lib/reportMap.js) and the now-fixed all-sites rewind probe, so this isn't
// exposed to the bare-single-row blind spot (task #406/#409) that plain extractRows() has.
//
// Run:  node --env-file=.env scripts/probe-enfield-movedetail-july.js
import { callReport, extractNamedTable } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const str = (v) => String(v ?? '').trim();
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? '').trim());

const SITE = 'L008';
const julyStart = new Date(2026, 6, 1);
const now = new Date();

const { raw } = await callReport('MoveInsAndMoveOuts', SITE, julyStart, now);
const rows = extractNamedTable(raw, 'UnitMoveInsAndMoveOuts');

console.log(`${'='.repeat(120)}`);
console.log(`Enfield (L008) — every MoveInsAndMoveOuts row, ${julyStart.toDateString()} -> ${now.toDateString()}`);
console.log(`Total rows returned: ${rows.length}`);
console.log(`${'='.repeat(120)}`);

const byDate = {};
let inCount = 0, outCount = 0, inArea = 0, outArea = 0;
const detail = [];

for (const r of rows) {
  const inFlag = yes(r.MoveIn), outFlag = yes(r.MoveOut);
  const date = str(r.MoveDate || r.dMoveDate || r.MoveInDate || r.MoveOutDate || '(no date field found)');
  const area = inFlag ? num(r.MovedInArea) : outFlag ? num(r.MovedOutArea) : 0;
  const tenant = str(r.TenantName || r.sTenantName || '(no name field found)');
  const unit = str(r.UnitID || r.sUnitID || r.UnitSize || '');

  if (inFlag) { inCount++; inArea += num(r.MovedInArea); }
  if (outFlag) { outCount++; outArea += num(r.MovedOutArea); }

  byDate[date] = byDate[date] || { in: 0, out: 0, inArea: 0, outArea: 0 };
  if (inFlag) { byDate[date].in++; byDate[date].inArea += num(r.MovedInArea); }
  if (outFlag) { byDate[date].out++; byDate[date].outArea += num(r.MovedOutArea); }

  detail.push({ date, inFlag, outFlag, area, tenant, unit, raw: r });
}

console.log(`\nPer-row detail (${detail.length} rows):`);
for (const d of detail) {
  console.log(`  ${d.date.padEnd(14)} ${d.inFlag ? 'MOVE-IN ' : d.outFlag ? 'MOVE-OUT' : '(neither flag set)'}  area=${d.area}  unit=${d.unit}  tenant=${d.tenant}`);
}

console.log(`\nGrouped by date (look for suspicious clustering -- many rows on one date suggests an\nimport/backfill event rather than organic day-by-day churn):`);
for (const [date, agg] of Object.entries(byDate).sort()) {
  console.log(`  ${date.padEnd(14)} in=${agg.in}(${R2(agg.inArea)}sqft)  out=${agg.out}(${R2(agg.outArea)}sqft)  net=${R2(agg.inArea - agg.outArea)}sqft`);
}

console.log(`\nTotals: ${inCount} move-ins (${R2(inArea)}sqft), ${outCount} move-outs (${R2(outArea)}sqft), net=${R2(inArea - outArea)}sqft`);
console.log(`(probe-realrate-rewound-area-all-sites.js computed net=+1729sqft/+10u for this exact window --\nshould match inCount-outCount and inArea-outArea above; if it doesn't, that's its own bug to chase.)`);

if (detail.length && !detail[0].date.match(/\d/)) {
  console.log(`\n*** NOTE: no recognizable date field matched (tried MoveDate/dMoveDate/MoveInDate/MoveOutDate).`);
  console.log(`Raw field dump of first row for reference:`);
  console.log(JSON.stringify(detail[0].raw, null, 2));
}

console.log('='.repeat(120));
process.exit(0);
