// Move-ins & Move-outs stat card is showing ~10x the legacy portal's target numbers for June 2026
// (target: 998 move-ins, 545 move-outs, 30,946 net ft² portfolio-wide). This dumps the RAW stored
// ManagementSummary parse output (d/mo/y counts for every labelled row) for every site's current
// month, plus the portfolio sum of `move_ins`/`move_outs`/`net_area` as buildPayload.js computes
// them today — so we can see exactly which number is wrong and by how much, without guessing.
// NO SiteLink call — reads straight from Supabase raw_report, so it's instant.
// PII-SAFE: only prints site codes/labels/counts, no tenant data.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-moveinsouts.js
import { admin } from '../lib/supabaseAdmin.js';

const { data, error } = await admin.from('raw_report')
  .select('site_code,month,data').eq('report', 'management')
  .order('month', { ascending: false });
if (error) { console.log('err', error.message); process.exit(1); }
if (!data?.length) { console.log('no management rows stored — has it been pulled?'); process.exit(0); }

const latestMonth = data[0].month;
const rows = data.filter(r => r.month === latestMonth);
console.log(`month: ${latestMonth}  (${rows.length} site rows)\n`);

let totalMoveIns = 0, totalMoveOuts = 0, totalNetArea = 0;
for (const r of rows) {
  const d = r.data || {};
  totalMoveIns += d.move_ins || 0;
  totalMoveOuts += d.move_outs || 0;
  totalNetArea += d.net_area || 0;
}
console.log(`Portfolio sum (as buildPayload.js computes today): move_ins=${totalMoveIns}  move_outs=${totalMoveOuts}  net_area=${totalNetArea}`);
console.log(`Target (legacy portal, June 2026): move_ins=998  move_outs=545  net_area=30946`);
console.log(`Ratio: move_ins x${(totalMoveIns / 998).toFixed(2)}   move_outs x${(totalMoveOuts / 545).toFixed(2)}\n`);

// Full raw dump for ONE site so we can see exactly what SiteLink's ManagementSummary returned —
// this is the parsed {d,mo,y} object per label, straight out of lib/reportMap.js's `management` parser.
console.log('--- Per-site move_ins / move_outs / net_area (parsed) ---');
for (const r of rows) console.log(`${r.site_code.padEnd(6)} move_ins=${String(r.data?.move_ins ?? '?').padStart(5)}  move_outs=${String(r.data?.move_outs ?? '?').padStart(5)}  net_area=${String(r.data?.net_area ?? '?').padStart(8)}`);
process.exit(0);
