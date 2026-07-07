// Same candidate-field test as probe-rentroll-rate.js (npm run probe:rr), but scoped to the
// CURRENT month-to-date (matching what lib/pull.js actually queries in production, and matching
// whatever period the live portal's "Rate per ft²" screen is showing today) instead of "last
// complete month". Prints all sites so it can be diffed directly against a live screenshot.
// Run:  npm run probe:now
import { callReport } from '../lib/sitelink.js';

const NAMES = { L001: 'Bicester', L002: 'Leighton Buzzard', L003: 'Letchworth', L004: 'Chippenham', L005: 'Brighton', L006: 'Huntingdon', L007: 'Newmarket', L008: 'Enfield', L009: 'Newbury', L010: 'Mitcham', L011: 'Sittingbourne', L012: 'Gillingham', L013: 'Brentwood', L014: 'Earlsfield', L015: 'Watford', L016: 'Seaford', L017: 'Southend', L018: 'Woking', L019: 'Sidcup', L020: 'Dunstable', L021: 'Bedford', L022: 'Swindon', L023: 'Wisbech', L024: 'Newcastle', L025: 'Shoreham-By-Sea', L026: 'Paulton', L027: 'Exeter' };

const codes = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);   // 1st of THIS month
const end = now;                                                 // today (matches lib/pull.js's endOf() cap)
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const isSS = (t) => /self.?storage/i.test(t || '');
const occd = (r) => num(r.bRented) === 1 || /^(1|true|yes)$/i.test(String(r.bRented ?? ''));

// candidate per-unit monthly-rate fields to test, plus a billing-frequency-adjusted dcRent column
// (mirrors the production formula in lib/reportMap.js: ×13/12 for 28-day billing, ×52/12 weekly)
const FIELDS = ['dcRent', 'dcStandardRate', 'dcStdRate'];

console.log(`Current month-to-date · ${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}\n`);
const head = 'site               scope | ' + FIELDS.map(f => f.replace('dc', '').padStart(9)).join(' | ') + ' | dcRent×adj';
console.log(head);

for (const loc of codes) {
  let rows;
  try { ({ rows } = await callReport('RentRoll', loc, start, end)); }
  catch (e) { console.log(`${(NAMES[loc] || loc).padEnd(18)}: ERROR ${e.message}`); continue; }
  const acc = { ss: { area: 0, adjRent: 0 }, all: { area: 0, adjRent: 0 } };
  FIELDS.forEach(f => { acc.ss[f] = 0; acc.all[f] = 0; });
  for (const r of rows) {
    if (!occd(r)) continue;
    const a = num(r.Area) || num(r.Area1); if (!a) continue;
    const ss = isSS(r.sTypeName);
    const w = num(r.dcStdWeeklyRate), s = num(r.dcStandardRate) || num(r.dcStdRate);
    let periods = 12;
    if (w > 0 && !s) periods = 52 / 12 * 12; // weekly billing -> annualise weekly rate directly below instead
    const adjRent = w > 0 && !s ? num(r.dcRent) * (52 / 12) : num(r.dcRent) * (13 / 12);
    for (const sc of [acc.all, ss ? acc.ss : null]) {
      if (!sc) continue;
      sc.area += a; sc.adjRent += adjRent;
      for (const f of FIELDS) sc[f] += num(r[f]);
    }
  }
  const line = (scope, label) => {
    const o = acc[scope];
    const cells = FIELDS.map(f => (o.area ? (o[f] / o.area * 12) : 0).toFixed(2).padStart(9));
    const adj = (o.area ? (o.adjRent / o.area * 12) : 0).toFixed(2).padStart(10);
    return `${label.padEnd(18)} ${scope === 'ss' ? 'SS ' : 'ALL'}   | ${cells.join(' | ')} | ${adj}`;
  };
  console.log(line('ss', NAMES[loc] || loc));
  console.log(line('all', ''));
}
process.exit(0);
