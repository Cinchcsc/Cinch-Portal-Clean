// Follow-up to probe-enquiries-july-live.js (8 Jul 2026): that LIVE SiteLink call reproduced our
// stored Walk-ins=76 exactly, while legacy shows 60 — ruling staleness OUT and confirming a real,
// reproducible gap (Phone/Web/Total's gaps, by contrast, WERE mostly staleness: live Phone=51/Web=869
// landed near legacy's 52/862, only Walk-ins held steady at our number instead of legacy's).
// reportMap.js's management parser grabs walkin_leads via `f(/walk.?in lead/i).mo` — a loose regex
// against ManagementSummary's UnitActivity table, which returns the FIRST row whose sDesc matches
// (not a sum of matches, per `f()`'s early-return). If SiteLink's own row label isn't quite what we
// assume, or there's a second walk-in-flavoured row ranked differently than expected, this dumps
// EVERY row's raw sDesc + d/mo/y for a couple of sites, unfiltered, so we can see exactly what's there
// instead of guessing at the regex's blind spot.
// PII-SAFE: labels + counts only, no tenant data.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-walkin-label-dump.js [siteCode ...]
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

const sites = process.argv.slice(2).length ? process.argv.slice(2) : ['L001', 'L012'];
const start = new Date(2026, 6, 1);
let end = new Date(); if (end > new Date(2026, 6, 31)) end = new Date(2026, 6, 31);

for (const loc of sites) {
  console.log(`\n=== ${loc} — every UnitActivity row, Jul 2026 MTD, raw sDesc + d/mo/y ===`);
  try {
    const { rows } = await callReport('ManagementSummary', loc, start, end);
    for (const r of rows) {
      const desc = r.sDesc;
      const d = num(r, 'iDCount'), mo = num(r, 'iMCount'), y = num(r, 'iYCount');
      const flag = /walk/i.test(desc || '') ? '  <-- matches /walk/i' : '';
      console.log(`  "${desc}"   d=${d}  mo=${mo}  y=${y}${flag}`);
    }
    console.log(`  (${rows.length} rows total)`);
  } catch (e) { console.log(`  error: ${e.message}`); }
}
process.exit(0);
