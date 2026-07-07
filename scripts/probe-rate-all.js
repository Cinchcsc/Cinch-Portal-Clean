// Extends probe-rate.js (which only checked Bicester) to EVERY configured site, and also pulls
// RentRoll alongside OccupancyStatistics so we can see which report + which formula the live
// portal's "Rate per ft²" screenshot actually matches. Prints one row per site with four
// OccupancyStatistics-based candidate rates plus the RentRoll-based rate for comparison.
// Run locally:  cd cinch-portal-clean && node --env-file=.env scripts/probe-rate-all.js
import { callReport } from '../lib/sitelink.js';

const NAMES = { L001: 'Bicester', L002: 'Leighton Buzzard', L003: 'Letchworth', L004: 'Chippenham', L005: 'Brighton', L006: 'Huntingdon', L007: 'Newmarket', L008: 'Enfield', L009: 'Newbury', L010: 'Mitcham', L011: 'Sittingbourne', L012: 'Gillingham', L013: 'Brentwood', L014: 'Earlsfield', L015: 'Watford', L016: 'Seaford', L017: 'Southend', L018: 'Woking', L019: 'Sidcup', L020: 'Dunstable', L021: 'Bedford', L022: 'Swindon', L023: 'Wisbech', L024: 'Newcastle', L025: 'Shoreham-By-Sea', L026: 'Paulton', L027: 'Exeter' };

const locs = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };

console.log(`Period: ${start.toISOString().slice(0, 10)} → ${now.toISOString().slice(0, 10)}\n`);
console.log('Site                | areaW-Actual | areaW-Std | RentRoll-rate | RentRoll?');
console.log('--------------------|--------------|-----------|---------------|----------');

for (const loc of locs) {
  try {
    const { rows: occRows } = await callReport('OccupancyStatistics', loc, start, now);
    let occA = 0, rent = 0, gocc = 0;
    for (const r of occRows) {
      const o = num(r.Occupied), a = num(r.Area), rr = num(r.ActualOccupied), gc = num(r.GrossOccupied);
      occA += a * o; rent += rr; gocc += gc;
    }
    const areaWActual = occA ? +(rent / occA * 12).toFixed(2) : 0;
    const areaWStd = occA ? +(gocc / occA * 12).toFixed(2) : 0;

    let rrRate = 0, rrHas = false;
    try {
      const { rows: rrRows } = await callReport('RentRoll', loc, start, now);
      if (rrRows.length) {
        const first = rrRows[0];
        const candidate = num(first.RatePerSqftAnn ?? first.Rate_Per_Sqft_Ann ?? first.AnnualRatePerSqft);
        if (candidate > 0) { rrRate = candidate; rrHas = true; }
      }
    } catch (e) { /* RentRoll may not be callable per-site the same way; ignore for this probe */ }

    console.log(`${(NAMES[loc] || loc).padEnd(19)} | £${areaWActual.toFixed(2).padStart(10)} | £${areaWStd.toFixed(2).padStart(7)} | £${rrRate.toFixed(2).padStart(11)} | ${rrHas}`);
  } catch (e) {
    console.log(`${(NAMES[loc] || loc).padEnd(19)} | ERROR: ${e.message}`);
  }
}
process.exit(0);
