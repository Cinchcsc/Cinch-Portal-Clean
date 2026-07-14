// Task #201 — Michael: "the move ins move outs net sqft looks wrong." Investigating two independent
// possibilities before changing any formula (per his explicit "check if this is correct before
// changing anything"):
//
//   1. FORMULA: net_area = moved_in_area - moved_out_area (reportMap.js's move_ins_outs parser,
//      both summed as positive magnitudes off MoveInsAndMoveOuts). Read the code directly — this is
//      already correct arithmetic (equivalent to "total move-out area (negative) plus total move-in
//      area", exactly what Michael described). Not re-tested here; this script is about the OTHER
//      open question:
//
//   2. DATE WINDOW: lib/pull.js pulls a CLOSED month with dReportDateStart = 1st of month @00:00:00
//      and dReportDateEnd = LAST DAY of month @00:00:00 (midnight, not end-of-day — see
//      lib/sitelink.js's fmtDate()). If SiteLink treats dReportDateEnd as an exact timestamp cutoff
//      rather than a whole calendar day, every closed month's LAST DAY of move-in/move-out activity
//      would be silently dropped from Move-ins, Move-outs, Sqft In, Sqft Out, and Net ft² alike —
//      every month, every site, always undercounting by whatever happened to move on that last day.
//
// This script calls MoveInsAndMoveOuts LIVE for the LAST COMPLETE MONTH, once per site, with THREE
// different end-of-range timestamps, and diffs the parsed results:
//   A) end = last day @ 00:00:00   (today's actual production window)
//   B) end = last day @ 23:59:59   (extends through the end of that day)
//   C) end = 1st of NEXT month @ 00:00:00   (a second, even more generous "next midnight" variant)
// If A/B/C all agree, SiteLink is normalizing to whole days internally and this isn't the bug.
// If B and/or C are consistently higher than A, that's a confirmed systemic undercount, and this
// output pinpoints which sites/how much, so the fix can be verified afterward.
//
// Also prints what's currently STORED (raw_report, no live call) for the same site/month, so Michael
// can see whether the PRODUCTION figure matches window A (expected) or something else entirely (which
// would point at a different, unrelated bug).
//
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-moveinsouts-boundary.js
import { admin } from '../lib/supabaseAdmin.js';
import { callReport } from '../lib/sitelink.js';
import { REPORTS } from '../lib/reportMap.js';
import { checkPullLock } from '../lib/pullLock.js';

const lock = await checkPullLock();
if (lock.locked) { console.log(`[probe-moveinsouts-boundary] ${lock.message} — aborting, a real pull is in progress.`); process.exit(0); }

const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
if (!locations.length) { console.error('SITELINK_LOCATIONS not set'); process.exit(1); }

const now = new Date();
// last COMPLETE month (if today is in July, that's June)
const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const lastDayMidnight = new Date(now.getFullYear(), now.getMonth(), 0);       // day 0 of THIS month = last day of prev month @00:00:00 — same as lib/pull.js's endOf()
const lastDayEndOfDay = new Date(lastDayMidnight); lastDayEndOfDay.setHours(23, 59, 59, 999);
const nextMonthMidnight = new Date(now.getFullYear(), now.getMonth(), 1);      // 1st of THIS month @00:00:00 (= "next midnight" after prev month)
const monthKey = `${prevMonthStart.getFullYear()}-${String(prevMonthStart.getMonth() + 1).padStart(2, '0')}-01`;

console.log(`=== Move-ins/Move-outs boundary probe — ${monthKey.slice(0, 7)} (last complete month) ===`);
console.log(`Window A (production today): ${prevMonthStart.toDateString()} -> ${lastDayMidnight.toISOString()}`);
console.log(`Window B (end-of-day):       ${prevMonthStart.toDateString()} -> ${lastDayEndOfDay.toISOString()}`);
console.log(`Window C (next-midnight):    ${prevMonthStart.toDateString()} -> ${nextMonthMidnight.toISOString()}`);
console.log(`${locations.length} sites x 3 windows = ${locations.length * 3} SiteLink calls, sequential (may take a few minutes)...\n`);

// SEQUENTIAL, same as every other script/pull in this codebase — SiteLink throws -99 "General
// Exception from LogOn" when the same account logs on in parallel (see lib/pull.js's own comment),
// so this deliberately does NOT Promise.all() the 3 windows per site.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function tryCall(loc, start, end) {
  const backoff = [0, 2000, 5000];
  for (let attempt = 1; ; attempt++) {
    try { return await callReport('MoveInsAndMoveOuts', loc, start, end); }
    catch (e) { if (attempt >= backoff.length) throw e; await sleep(backoff[attempt]); }
  }
}

const rows = [];
let i = 0;
for (const loc of locations) {
  i++;
  process.stderr.write(`[${i}/${locations.length}] ${loc}...\n`);
  const a = await tryCall(loc, prevMonthStart, lastDayMidnight);
  const b = await tryCall(loc, prevMonthStart, lastDayEndOfDay);
  const c = await tryCall(loc, prevMonthStart, nextMonthMidnight);
  const pa = REPORTS.move_ins_outs.parse(a.rows);
  const pb = REPORTS.move_ins_outs.parse(b.rows);
  const pc = REPORTS.move_ins_outs.parse(c.rows);

  const { data: stored } = await admin.from('raw_report').select('data,pulled_at').eq('report', 'move_ins_outs').eq('site_code', loc).eq('month', monthKey).maybeSingle();
  let sd = stored?.data; if (typeof sd === 'string') { try { sd = JSON.parse(sd); } catch {} }

  rows.push({ loc, pa, pb, pc, stored: sd, rowsA: a.rows.length, rowsB: b.rows.length, rowsC: c.rows.length });
}

console.log('\n=== Per-site results ===');
console.log('site   rowsA/B/C   moveIns A/B/C   moveOuts A/B/C   netArea A/B/C            stored netArea   DIFF?');
console.log('-'.repeat(110));
// NOTE (14 Jul 2026, corrected after first live run): A vs B is the ACTUAL test for "does midnight vs
// end-of-day on the SAME calendar date matter" — both name June 30, just at different times. C is a
// DIFFERENT calendar date entirely (July 1st @00:00), so C differing from A is expected whenever July
// 1st had any real move-in/move-out activity — that's C picking up an extra day, not "recovering"
// anything. Only an A vs B difference would mean midnight-vs-end-of-day time-of-day matters; A vs C
// differing proves nothing about that question. Tracked separately below.
let anyDiffAB = false, anyDiffAC = false;
for (const r of rows) {
  const diffAB = r.pa.net_area !== r.pb.net_area || r.rowsA !== r.rowsB;
  const diffAC = r.pa.net_area !== r.pc.net_area || r.rowsA !== r.rowsC;
  if (diffAB) anyDiffAB = true;
  if (diffAC) anyDiffAC = true;
  const flag = diffAB ? '<<<< A vs B DIFFERS (real bug signal)' : (diffAC ? '(C differs — likely just Jul 1st activity, not a bug)' : '');
  console.log(
    `${r.loc.padEnd(6)} ${String(r.rowsA).padStart(3)}/${String(r.rowsB).padStart(3)}/${String(r.rowsC).padStart(3)}` +
    `      ${String(r.pa.move_ins).padStart(3)}/${String(r.pb.move_ins).padStart(3)}/${String(r.pc.move_ins).padStart(3)}` +
    `        ${String(r.pa.move_outs).padStart(3)}/${String(r.pb.move_outs).padStart(3)}/${String(r.pc.move_outs).padStart(3)}` +
    `         ${String(r.pa.net_area).padStart(6)}/${String(r.pb.net_area).padStart(6)}/${String(r.pc.net_area).padStart(6)}` +
    `      ${String(r.stored?.net_area ?? '(none)').padStart(10)}      ${flag}`
  );
}

const sum = (rowsArr, key, sub) => rowsArr.reduce((acc, r) => acc + (r[sub][key] || 0), 0);
console.log('\n=== Portfolio totals ===');
console.log(`Move-ins:   A=${sum(rows, 'move_ins', 'pa')}  B=${sum(rows, 'move_ins', 'pb')}  C=${sum(rows, 'move_ins', 'pc')}`);
console.log(`Move-outs:  A=${sum(rows, 'move_outs', 'pa')}  B=${sum(rows, 'move_outs', 'pb')}  C=${sum(rows, 'move_outs', 'pc')}`);
console.log(`Moved-in area:  A=${sum(rows, 'moved_in_area', 'pa')}  B=${sum(rows, 'moved_in_area', 'pb')}  C=${sum(rows, 'moved_in_area', 'pc')}`);
console.log(`Moved-out area: A=${sum(rows, 'moved_out_area', 'pa')}  B=${sum(rows, 'moved_out_area', 'pb')}  C=${sum(rows, 'moved_out_area', 'pc')}`);
console.log(`Net area:   A=${sum(rows, 'net_area', 'pa')}  B=${sum(rows, 'net_area', 'pb')}  C=${sum(rows, 'net_area', 'pc')}`);
const storedNet = rows.reduce((a, r) => a + (r.stored?.net_area || 0), 0);
console.log(`Stored (production) net area total: ${storedNet}`);

console.log('\n=== Verdict ===');
if (!anyDiffAB) {
  console.log('A and B are IDENTICAL for every site (C is expected to differ — see note above, not evidence of a');
  console.log('bug) — SiteLink normalizes the end date to the WHOLE calendar day named, regardless of the time');
  console.log('component. Midnight-vs-end-of-day is NOT causing an undercount. Do NOT adopt window C (pushing to');
  console.log('the 1st of next month) — that would double-count that day\'s real activity into the wrong month.');
  console.log('lib/pull.js\'s current endOf()/fmtDate() end-date handling is correct as-is; no change needed.');
  console.log('If the portal\'s net sqft still looks wrong, the bug is elsewhere — worth checking the STORED');
  console.log('column above against A: if stored != A, the pipeline captured this month\'s data before it was');
  console.log('locked (see lib/pull.js\'s prevLocked comment) and is now frozen on a stale/partial snapshot.');
} else {
  console.log('A vs B differ for at least one site — CONFIRMED: ending the request at midnight of the last day');
  console.log('(today\'s production behavior) misses some of that SAME day\'s move-ins/move-outs. Recommend');
  console.log('changing lib/pull.js\'s endOf() (or lib/sitelink.js\'s fmtDate() end-date handling) to push the');
  console.log('end boundary to 23:59:59 that same day (matches B) — and applying it to every other `dated: true`');
  console.log('report call in the pipeline (lead_funnel, insurance_roll, insurance_activity, discounts,');
  console.log('true_revenue, rate_changes, financial, merchandise, marketing, management, past_due,');
  console.log('reservations, rental_activity), not just move_ins_outs, since they all share this same');
  console.log('endOf()/fmtDate() path. NOTE: true_revenue\'s period_days calc and insurance_roll/discounts\' own');
  console.log('date-window filters would also need adjusting to match the new end-date convention.');
}
process.exit(0);
