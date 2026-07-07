// Live SiteLink call: Insurance Conversion is still showing 0 even after switching to a dMovedIn
// window filter (no cross-report ID matching). This checks whether `dMovedIn` is actually populated/
// parseable on InsuranceRoll rows at all, and whether any fall within the target month — without
// printing any PII (only dates + iActive, never sName/sPolicyNum/etc).
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-insurance-movedin.js [siteCode]
import { callReport } from '../lib/sitelink.js';

const loc = (process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',')[0] || '').trim();
if (!loc) { console.error('No site code given and SITELINK_LOCATIONS not set'); process.exit(1); }

const now = new Date();
const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const prevEnd = new Date(now.getFullYear(), now.getMonth(), 0);   // last day of previous month

const { rows } = await callReport('InsuranceRoll', loc, prevMonth, prevEnd);
console.log(`Site ${loc}: ${rows ? rows.length : 0} rows for period ${prevMonth.toISOString().slice(0,10)} to ${prevEnd.toISOString().slice(0,10)}\n`);
if (!rows || !rows.length) { console.log('No rows returned.'); process.exit(0); }

let activeCount = 0, dMovedInPopulated = 0, dMovedInParseable = 0, inWindow = 0;
const sampleDates = [];
for (const r of rows) {
  const active = r.iActive === true || r.iActive === 1 || /^(1|true|yes)$/i.test(String(r.iActive ?? ''));
  if (active) activeCount++;
  const raw = r.dMovedIn;
  if (raw != null && raw !== '') {
    dMovedInPopulated++;
    const d = new Date(raw);
    if (!isNaN(d)) {
      dMovedInParseable++;
      if (d >= prevMonth && d <= prevEnd) inWindow++;
      if (sampleDates.length < 10) sampleDates.push({ raw, parsed: d.toISOString().slice(0, 10), active });
    } else if (sampleDates.length < 10) {
      sampleDates.push({ raw, parsed: 'UNPARSEABLE', active });
    }
  }
}
console.log(`Active policies: ${activeCount}/${rows.length}`);
console.log(`dMovedIn populated (non-null/non-empty): ${dMovedInPopulated}/${rows.length}`);
console.log(`dMovedIn parseable as a date: ${dMovedInParseable}/${dMovedInPopulated}`);
console.log(`Rows with dMovedIn inside ${prevMonth.toISOString().slice(0,10)}..${prevEnd.toISOString().slice(0,10)}: ${inWindow}`);
console.log(`\nSample raw dMovedIn values (dates only, no PII):`);
for (const s of sampleDates) console.log(`  raw="${s.raw}"  parsed=${s.parsed}  active=${s.active}`);
process.exit(0);
