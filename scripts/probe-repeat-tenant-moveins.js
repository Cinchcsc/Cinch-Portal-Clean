// Michael got a real legacy number: Abingdon (L029) = £41.20 for the same July 1-9 window
// probe-merch-activity.js has been testing. Comparing all 5 tested numerators against it, across
// all 3 known legacy data points (L001=£0, L012=£0, L029=£41.20):
//   ALL sales:        L001 WRONG (£24.00 vs 0), L012 WRONG (£15.23 vs 0), L029 close (£42.43 vs 41.20)
//   excl. Walk-In:     L001 EXACT (£0=£0),      L012 EXACT (£0=£0),        L029 low (£16.43 vs 41.20)
//   Locks only:        L001 EXACT,               L012 EXACT,               L029 way low (£1.43 vs 41.20)
// Any formula that includes Walk-In POS can never produce a true £0 at L001, which has £120 of real
// Walk-In sales this window -- so ALL-sales' close L029 match has to be partly coincidental. That
// makes "excl. Walk-In" (named-tenant merch ÷ move-ins) the only formula consistent with the SIGN/
// zero-ness of all 3 points -- it just undershoots L029's magnitude by ~60%.
// Grounded hypothesis for that gap: our move-ins denominator counts every MoveIn=true row, but an
// EXISTING tenant renting an ADDITIONAL unit at the same site also sets MoveIn=true on that new
// unit -- they are not a new CUSTOMER, just a new unit for someone already on the books. If several
// of L029's 7 move-ins this period are existing tenants adding a unit, the true new-customer count
// is smaller than 7, which would push named-tenant-£/true-new-customers up toward £41.20 without
// touching L001/L012 (0 divided by anything smaller is still 0 -- can't break those two matches).
// Tests this directly: RentRoll and MoveInsAndMoveOuts share the SAME TenantID space (confirmed --
// unlike InquiryTracking's separate ID space, see lib/reportMap.js's move_ins/insurance notes) so we
// can join on it. For each move-in TenantID this period, check how many units that TenantID
// currently occupies in RentRoll: 1 unit = looks genuinely new, 2+ units = existing customer adding
// a unit. TenantID is used only as an opaque join key here -- never printed, no names ever touched.
// Run one site:      cd cinch-portal-clean && node --env-file=.env scripts/probe-repeat-tenant-moveins.js L029
// Run the portfolio: cd cinch-portal-clean && node --env-file=.env scripts/probe-repeat-tenant-moveins.js ALL
import { callReport } from '../lib/sitelink.js';
import { REPORTS } from '../lib/reportMap.js';

const siteArg = process.argv[2] || 'L029';
const monthArg = process.argv[3];
const now = new Date();
let start, end;
if (monthArg) {
  const [y, m] = monthArg.split('-').map(Number);
  start = new Date(y, m - 1, 1);
  const fullMonthEnd = new Date(y, m, 0);
  const isCurrentMonth = y === now.getFullYear() && m === now.getMonth() + 1;
  end = isCurrentMonth && fullMonthEnd > now ? now : fullMonthEnd;
} else {
  start = new Date(now.getFullYear(), now.getMonth(), 1);
  end = now;
}
const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const num = (v) => Number(v) || 0;
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? ''));

async function runSite(siteCode) {
  // RentRoll is a live point-in-time snapshot regardless of the date args passed (confirmed
  // elsewhere in this codebase) -- gives us TODAY's actual occupied-unit-per-tenant state.
  const { rows: rrRows } = await callReport('RentRoll', siteCode, start, end);
  const unitsByTenant = {};
  for (const r of rrRows) {
    if (!yes(r.bRented)) continue;
    const tid = String(r.TenantID ?? '');
    if (!tid) continue;
    unitsByTenant[tid] = (unitsByTenant[tid] || 0) + 1;
  }

  const { rows: mgRows } = await callReport('MoveInsAndMoveOuts', siteCode, start, end);
  const moveInRows = mgRows.filter((r) => yes(r.MoveIn));
  const moveIns = moveInRows.length;
  let repeat = 0, single = 0, noMatch = 0;
  for (const r of moveInRows) {
    const tid = String(r.TenantID ?? '');
    const units = tid ? (unitsByTenant[tid] || 0) : 0;
    if (units >= 2) repeat++;
    else if (units === 1) single++;
    else noMatch++;
  }

  const { rows: msRows } = await callReport(REPORTS.merchandise.method, siteCode, start, end);
  const officialSales = msRows.reduce((a, r) => a + num(r.dcChargeTotal), 0);

  return { moveIns, repeat, single, noMatch, officialSales };
}

if (siteArg.toUpperCase() === 'ALL') {
  const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!locations.length) { console.error('SITELINK_LOCATIONS not set'); process.exit(1); }
  console.log(`=== Repeat-tenant move-ins probe, ALL ${locations.length} sites, ${fmt(start)} to ${fmt(end)} ===\n`);
  console.log(`${'Site'.padEnd(6)}${'MoveIns'.padStart(9)}${'Repeat'.padStart(8)}${'Single'.padStart(8)}${'NoMatch'.padStart(9)}`);
  let totalMoveIns = 0, totalRepeat = 0, totalSingle = 0, totalNoMatch = 0;
  for (const loc of locations) {
    try {
      const r = await runSite(loc);
      console.log(`${loc.padEnd(6)}${String(r.moveIns).padStart(9)}${String(r.repeat).padStart(8)}${String(r.single).padStart(8)}${String(r.noMatch).padStart(9)}`);
      totalMoveIns += r.moveIns; totalRepeat += r.repeat; totalSingle += r.single; totalNoMatch += r.noMatch;
    } catch (e) { console.error(`${loc}: FAILED — ${e.message}`); }
  }
  console.log(`\n${totalMoveIns} total move-ins: ${totalRepeat} existing tenant adding a unit (Repeat), ${totalSingle} single-unit (looks new), ${totalNoMatch} no RentRoll match (moved out again within window, or a data gap).`);
  console.log(`If "new customer" should mean single-unit only: true new-customer count = ${totalSingle} (vs raw move-ins ${totalMoveIns}).`);
} else {
  console.log(`=== Repeat-tenant move-ins probe, ${siteArg}, ${fmt(start)} to ${fmt(end)} ===\n`);
  const r = await runSite(siteArg);
  console.log(`${r.moveIns} move-ins this window: ${r.repeat} existing tenant adding a unit (Repeat), ${r.single} single-unit (looks new), ${r.noMatch} no RentRoll match.`);
  console.log(`MerchandiseSummary.dcChargeTotal this window (reconciliation only, NOT the leading numerator hypothesis): £${r.officialSales.toFixed(2)}`);
}
process.exit(0);
