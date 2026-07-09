// We now have 3 real legacy data points for the same Jul 1-9 calendar range: L001=£0, L012=£0,
// L029=£41.20. "Excl. Walk-In / move-ins" is the only numerator that's sign-consistent (zero at
// L001/L012) but undershoots L029 by ~60% over the full 9-day month-to-date window. Pass 6/7 already
// ruled out both denominator-narrowing theories we could test (0 transfers, 0 repeat-tenant moves) —
// so the shortfall isn't a move-ins counting problem on our end.
// Different question: what if legacy's tile isn't month-to-date at all, but a SHORTER trailing
// window ending today (which would also explain the day-to-day volatility Michael already saw,
// £1.00 -> £1.10)? Rather than ask Michael to keep reading numbers off the legacy screen, this pulls
// each site's data ONCE over the full 9 days (with per-transaction dates: dDate/MoveDate), buckets
// locally by calendar day, then recomputes the ratio for EVERY trailing window from 1 to 9 days —
// zero extra SiteLink calls per window. If some N makes all 3 known sites land near their real
// legacy figures simultaneously, that's very likely the true window length (and which formula,
// excl.-Walk-In or ALL-sales, actually matches at that N).
// Run: cd cinch-portal-clean && node --env-file=.env scripts/probe-window-length.js
import { callReport } from '../lib/sitelink.js';
import { REPORTS } from '../lib/reportMap.js';

const now = new Date();
const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
const num = (v) => Number(v) || 0;
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? ''));
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const shortDate = (d) => `${d.toLocaleString('en-GB', { month: 'short' })}${String(d.getDate()).padStart(2, '0')}`;
const parseDate = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d; };

const KNOWN = { L001: 0, L012: 0, L029: 41.20 };
const sites = Object.keys(KNOWN);

async function runSite(siteCode) {
  const { rows: msRows } = await callReport(REPORTS.merchandise.method, siteCode, monthStart, now);
  const rateBySku = {};
  for (const r of msRows) {
    const units = Math.abs(num(r.dcSold));
    if (units > 0) rateBySku[r.sDesc] = num(r.dcChargeTotal) / units;
  }

  const { rows: actRows } = await callReport('MerchandiseActivity', siteCode, monthStart, now);
  const sold = actRows.filter((r) => /^sold$/i.test(r.sReason || ''));
  const namedByDay = {}, allByDay = {};
  for (const r of sold) {
    const rate = rateBySku[r.sDesc];
    if (rate == null) continue;
    const d = parseDate(r.dDate);
    if (!d) continue;
    const k = dayKey(d);
    const amount = rate * num(r.dcQty);
    allByDay[k] = (allByDay[k] || 0) + amount;
    const t = (r.sTenantName || '').trim();
    if (t && !/^walk-?in pos$/i.test(t)) namedByDay[k] = (namedByDay[k] || 0) + amount;
  }

  const { rows: mgRows } = await callReport('MoveInsAndMoveOuts', siteCode, monthStart, now);
  const moveInsByDay = {};
  for (const r of mgRows) {
    if (!yes(r.MoveIn)) continue;
    const d = parseDate(r.MoveDate);
    if (!d) continue;
    const k = dayKey(d);
    moveInsByDay[k] = (moveInsByDay[k] || 0) + 1;
  }

  return { namedByDay, allByDay, moveInsByDay };
}

console.log(`=== Trailing-window length test, ${sites.join(' / ')}, ending ${dayKey(now)} ===`);
console.log(`Known legacy figures (Jul 1-9): ${sites.map((s) => `${s}=£${KNOWN[s].toFixed(2)}`).join(', ')}\n`);
console.log(`Does a SHORTER trailing window (not the full 9-day MTD) make our ratio match all 3 at once?\n`);

const data = {};
for (const s of sites) data[s] = await runSite(s);

const maxDays = Math.floor((now - monthStart) / 86400000) + 1;

function printTable(label, byDayKey) {
  console.log(`--- ${label} £ ÷ move-ins ---`);
  console.log(`${'Window'.padEnd(16)}${sites.map((s) => s.padStart(10)).join('')}`);
  for (let n = 1; n <= maxDays; n++) {
    const windowStart = new Date(now); windowStart.setDate(windowStart.getDate() - (n - 1));
    const rowLabel = n === 1 ? shortDate(now) : `${shortDate(windowStart)}-${shortDate(now)}`;
    const row = [];
    for (const s of sites) {
      let numer = 0, moveIns = 0;
      for (let i = 0; i < n; i++) {
        const d = new Date(now); d.setDate(d.getDate() - i);
        const k = dayKey(d);
        numer += data[s][byDayKey][k] || 0;
        moveIns += data[s].moveInsByDay[k] || 0;
      }
      row.push(moveIns ? `£${(numer / moveIns).toFixed(2)}` : (numer ? '£inf' : '£0.00'));
    }
    console.log(`${rowLabel.padEnd(16)}${row.map((v) => v.padStart(10)).join('')}`);
  }
  console.log('');
}

printTable('excl. Walk-In (named)', 'namedByDay');
printTable('ALL sales', 'allByDay');

console.log('Look for the row where all 3 columns land closest to £0.00 / £0.00 / £41.20 at once —');
console.log("that N is the best estimate of legacy's real window length.");
process.exit(0);
