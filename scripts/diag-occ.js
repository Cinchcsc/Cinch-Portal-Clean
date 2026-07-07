// Diagnostic: why is recent-month occupancy stuck old-format, and does the date window
// change the occupancy count? READ-ONLY. Never prints credentials.
//   node --env-file=.env scripts/diag-occ.js [LOC] [YYYY-MM]
import { admin } from '../lib/supabaseAdmin.js';
import { pullReport } from '../lib/reportMap.js';

const LOC = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',')[0].trim();
const MONTH = process.argv[3] || '2026-05';
const [y, m] = MONTH.split('-').map(Number);

const correctStart = new Date(y, m - 1, 1);     // May 1
const correctEnd   = new Date(y, m, 0);         // May 31
const shiftStart   = new Date(y, m - 1, 0);     // Apr 30  (what the old UTC bug effectively queried)
const shiftEnd     = new Date(y, m, -1);        // May 30

const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
console.log(`\n=== Occupancy diag: site=${LOC} month=${MONTH} ===`);

// 1) what is stored right now
const { data: stored } = await admin.from('raw_report')
  .select('data,pulled_at').eq('site_code', LOC).eq('month', `${MONTH}-01`).eq('report', 'occupancy').maybeSingle();
if (!stored) console.log('STORED: (none)');
else {
  const d = stored.data || {};
  console.log(`STORED  pulled_at=${stored.pulled_at}`);
  console.log(`        occ=${d.occupied_units}/${d.total_units}  gross_occupied=${d.gross_occupied} cla_area=${d.cla_area} occ_pc=${d.occ_pc}  -> ${d.gross_occupied > 0 ? 'NEW format' : 'OLD format'}`);
}

// 2) fresh pull — correct calendar-month window
try {
  const { data, rowcount } = await pullReport('occupancy', LOC, correctStart, correctEnd);
  console.log(`FRESH  window ${fmt(correctStart)} → ${fmt(correctEnd)}  rows=${rowcount}`);
  console.log(`        occ=${data.occupied_units}/${data.total_units}  occ_pc=${data.occ_pc}  rate=${data.rate_per_sqft_ann} real=${data.real_rate_per_sqft_ann}`);
} catch (e) { console.log(`FRESH  correct-window ERROR: ${e.message} (retCode=${e.retCode})`); }

// 3) fresh pull — the OLD shifted window, to see if the date bug changed the count
try {
  const { data } = await pullReport('occupancy', LOC, shiftStart, shiftEnd);
  console.log(`SHIFT  window ${fmt(shiftStart)} → ${fmt(shiftEnd)}  occ=${data.occupied_units}/${data.total_units}  occ_pc=${data.occ_pc}`);
} catch (e) { console.log(`SHIFT  ERROR: ${e.message} (retCode=${e.retCode})`); }

process.exit(0);
