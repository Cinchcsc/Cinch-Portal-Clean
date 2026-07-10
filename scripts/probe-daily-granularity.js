// Probes whether InquiryTracking (lead_funnel: enquiries + reservations) and MoveInsAndMoveOuts
// (move_ins_outs: sqft in/out) genuinely respect a SINGLE-CALENDAR-DAY range, not just the
// month-partial ranges we've used everywhere else so far. This decides whether the Daily/Weekly/
// Quarterly Snapshot page (roadmap #5/#6) can (a) run a lean once-a-day pull for "yesterday" and
// (b) retroactively backfill recent history day-by-day instead of waiting for daily data to
// accumulate organically.
//
// Also dumps the full field list of a reservation-stage InquiryTracking row, to check for any
// scheduled/target move-in date field that could power a "forward move-ins" (pipeline, not-yet-
// moved-in) metric — move_ins_outs only reports move-ins that ALREADY happened in the queried
// window, it has no forward-looking date field.
//
// Run: node --env-file=.env scripts/probe-daily-granularity.js [siteCode]
// (Don't run concurrently with npm run pull / another script — SiteLink -99's on parallel logons.)
import { callReport } from '../lib/sitelink.js';

const site = process.argv[2] || 'L001';
const dayWindow = (daysAgo) => {
  const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(0, 0, 0, 0);
  const end = new Date(d); end.setHours(23, 59, 59, 999);
  return { start: d, end, label: d.toISOString().slice(0, 10) };
};

const windows = [1, 2, 7, 14].map(dayWindow);

console.log(`Site ${site} — single-day range probe (InquiryTracking + MoveInsAndMoveOuts)\n`);

for (const w of windows) {
  const { rows: inq } = await callReport('InquiryTracking', site, w.start, w.end);
  const { rows: mio } = await callReport('MoveInsAndMoveOuts', site, w.start, w.end);
  const enquiries = inq.filter(r => r.dPlaced && !isNaN(new Date(r.dPlaced))).length;
  const reservations = inq.filter(r => String(r.sRentalType || '').toLowerCase() === 'reservation').length;
  const moveIns = mio.filter(r => String(r.MoveIn).toLowerCase() === 'true' || r.MoveIn === true).length;
  const inArea = mio.reduce((a, r) => a + (Number(r.MovedInArea) || 0), 0);
  const outArea = mio.reduce((a, r) => a + (Number(r.MovedOutArea) || 0), 0);
  console.log(`${w.label}: InquiryTracking rows=${inq.length} (enquiries=${enquiries}, reservations=${reservations}) | MoveInsAndMoveOuts rows=${mio.length} (moveIns=${moveIns}, inArea=${inArea}, outArea=${outArea})`);
}

console.log('\n--- Sample reservation-stage InquiryTracking row (full fields, for "forward move-ins" field hunt) ---');
const { rows: recent } = await callReport('InquiryTracking', site, windows[2].start, windows[0].end); // 7-day window, more likely to have a reservation row
const resRow = recent.find(r => String(r.sRentalType || '').toLowerCase() === 'reservation');
if (resRow) {
  const clean = Object.fromEntries(Object.entries(resRow).filter(([k]) => k !== 'attributes'));
  console.log(JSON.stringify(clean, null, 2));
} else {
  console.log('(no reservation-stage row in the last 7 days for this site — try a busier site or wider window)');
}
