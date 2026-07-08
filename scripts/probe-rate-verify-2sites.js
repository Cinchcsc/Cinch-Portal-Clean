// Quick cross-check: is the "plain Rate" fix (dcStdRate ÷ occupied area × 12, applied to
// reportMap.js's rent_roll parser 8 Jul 2026) actually correct, or did it only look right on
// Bicester? Checks both known-target sites (L001, L012) in one pass.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-rate-verify-2sites.js
import { callReport } from '../lib/sitelink.js';

const num = (row, ...keys) => {
  for (const k of keys) {
    if (row && row[k] != null && row[k] !== '') {
      const n = Number(String(row[k]).replace(/[£,%\s]/g, ''));
      if (!Number.isNaN(n)) return n;
    }
  }
  return 0;
};
const yes = (v) => v === true || v === 'true' || v === 1 || v === '1';
const str = (v) => (v == null ? '' : String(v)).trim();
const isSS = (t) => str(t).toLowerCase().includes('self storage');

const TARGETS = {
  L001: { totalRate: 28.50, ssRate: 29.98 },
  L012: { totalRate: 32.78, ssRate: 32.46 },
};
const start = new Date(2026, 6, 1);
let end = new Date(); if (end > new Date(2026, 6, 31)) end = new Date(2026, 6, 31);

for (const loc of Object.keys(TARGETS)) {
  const { rows } = await callReport('RentRoll', loc, start, end);
  let occArea = 0, ssOccArea = 0, stdRateSum = 0, ssStdRateSum = 0;
  for (const r of rows) {
    if (!yes(r.bRented)) continue;
    const a = num(r, 'Area', 'Area1'), std = num(r, 'dcStdRate'), t = str(r.sTypeName) || 'Other';
    occArea += a; stdRateSum += std;
    if (isSS(t)) { ssOccArea += a; ssStdRateSum += std; }
  }
  const rate = occArea ? +((stdRateSum / occArea) * 12).toFixed(2) : 0;
  const ssRate = ssOccArea ? +((ssStdRateSum / ssOccArea) * 12).toFixed(2) : 0;
  const tgt = TARGETS[loc];
  console.log(`${loc}: Total Rate = £${rate}  (target £${tgt.totalRate}, ${(rate - tgt.totalRate >= 0 ? '+' : '')}${(rate - tgt.totalRate).toFixed(2)})`);
  console.log(`${loc}: SS Rate    = £${ssRate}  (target £${tgt.ssRate}, ${(ssRate - tgt.ssRate >= 0 ? '+' : '')}${(ssRate - tgt.ssRate).toFixed(2)})\n`);
}
process.exit(0);
