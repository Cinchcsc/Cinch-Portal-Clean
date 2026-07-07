// Hunt for a RELIABLE billing-frequency signal (vs the rate-ratio proxy).
// (1) lists every SiteLink report (maybe one exposes charge interval directly)
// (2) quantifies how ambiguous the rate-ratio signal is at this store
// (3) tests the billing-date cadence (monthly = fixed day-of-month; 4-weekly = spread)
// PII-SAFE: only the report list + numeric distributions.  node --env-file=.env scripts/probe-freq.js [LOC]
import { listMethods, callReport } from '../lib/sitelink.js';

const loc = process.argv[2] || 'L027';   // Exeter by default
const methods = await listMethods();
console.log('REPORTS AVAILABLE (' + methods.length + '):');
console.log(methods.join(', '));

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const { rows } = await callReport('RentRoll', loc, start, now);
const num = v => { const n = Number(String(v ?? '').replace(/[£,\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const occ = rows.filter(r => String(r.bRented) === '1' || /^(1|true|yes)$/i.test(String(r.bRented ?? '')));
console.log(`\n${loc}: ${occ.length} occupied units`);

// (2) implied periods = weekly×52 / standard  -> should be ~13 (4-weekly) or ~12 (monthly)
const per = {};
let clean = 0, ambiguous = 0;
for (const r of occ) {
  const w = num(r.dcStdWeeklyRate), s = num(r.dcStandardRate) || num(r.dcStdRate);
  if (!w || !s) { ambiguous++; continue; }
  const p = w * 52 / s; const k = p.toFixed(1); per[k] = (per[k] || 0) + 1;
  if (Math.abs(p - 13) < 0.25 || Math.abs(p - 12) < 0.25) clean++; else ambiguous++;
}
console.log('implied-periods (weekly×52÷standard):', JSON.stringify(per));
console.log(`clean(≈12 or ≈13): ${clean} | ambiguous/missing: ${ambiguous}`);

// (3) billing-date cadence: day-of-month of dPaidThru (monthly clusters on 1 day; 4-weekly spreads)
const dom = {};
for (const r of occ) { const d = new Date(r.dPaidThru); if (isNaN(+d)) continue; const k = d.getUTCDate(); dom[k] = (dom[k] || 0) + 1; }
console.log('\ndPaidThru day-of-month distribution:', JSON.stringify(dom));
process.exit(0);
