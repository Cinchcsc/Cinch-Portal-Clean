// "Enquiries widget is off" (Michael, 8 Jul 2026). Portal currently shows Jul 2026 (MTD):
// Phone=48, Walk-ins=76, Web=798, Total=922 — all sourced from ManagementSummary's
// phone_leads/walkin_leads/web_leads (lib/reportMap.js `management` parser, since the 7 Jul fix).
// Legacy portal's own Jul 2026 (MTD) Enquiries tile reads: Phone=52, Walk-ins=60, Web=862, Total=975.
// Walk-ins is the biggest outlier (76 vs 60, +27%); Total is undercounted by ~5% (922 vs 975).
// This calls SiteLink LIVE (bypassing our stored/cached raw_report + portal_payload entirely) for the
// exact same month-to-date window pull.js uses for the current month, to answer: is our STORED number
// just stale (a pull from a few hours/days ago, before more leads came in), or does even a fresh
// SiteLink call disagree with legacy right now? Per-site breakdown included in case one or two sites
// are driving the whole gap rather than it being portfolio-wide.
// PII-SAFE: aggregated counts only, no tenant/lead-level data printed.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-enquiries-july-live.js
import { callReport } from '../lib/sitelink.js';
import { REPORTS } from '../lib/reportMap.js';

const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
if (!locations.length) { console.error('SITELINK_LOCATIONS not set'); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
let end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
if (end > now) end = now;   // mirror pull.js's endOf() — month-to-date, capped at now
console.log(`Live SiteLink pull, ${locations.length} sites, window ${start.toISOString().slice(0, 10)} -> ${end.toISOString().slice(0, 10)} (matches pull.js's current-month logic)\n`);

let phone = 0, walkin = 0, web = 0, convertedLeads = 0, failed = 0;
const perSite = [];
for (const loc of locations) {
  process.stderr.write(`[enquiries-july-live] ${loc}...\n`);
  try {
    const { rows } = await callReport('ManagementSummary', loc, start, end);
    const p = REPORTS.management.parse(rows);
    phone += p.phone_leads || 0; walkin += p.walkin_leads || 0; web += p.web_leads || 0;
    convertedLeads += p.leads_converted || 0;
    perSite.push({ loc, phone: p.phone_leads || 0, walkin: p.walkin_leads || 0, web: p.web_leads || 0 });
  } catch (e) { failed++; console.log(`  ${loc}: error: ${e.message}`); }
}

const total = phone + walkin + web;
console.log('\n=== LIVE SiteLink ManagementSummary, Jul 2026 MTD, right now ===');
console.log(`Phone=${phone}  Walk-ins=${walkin}  Web=${web}  Total=${total}  (${failed} site(s) failed)`);
console.log(`(for reference) Leads Converted (mo): ${convertedLeads}`);
console.log('\nOur portal is CURRENTLY showing: Phone=48  Walk-ins=76  Web=798  Total=922');
console.log('Legacy portal is showing:        Phone=52  Walk-ins=60  Web=862  Total=975');
console.log('\nIf the LIVE numbers above are close to our portal\'s stored numbers, the gap vs legacy is a real');
console.log('parsing/mapping discrepancy (not staleness) — likely worth a closer look at how legacy computes');
console.log('its own Walk-in figure specifically, since that\'s the largest outlier.');
console.log('If the LIVE numbers above are close to LEGACY instead, our stored/cached portal_payload is just');
console.log('stale and needs a fresh `npm run pull` (or wait for the next cron run) to catch up.');

console.log('\nPer-site breakdown (top 10 by walk-in count, to spot any single site driving the gap):');
perSite.sort((a, b) => b.walkin - a.walkin).slice(0, 10)
  .forEach((s) => console.log(`  ${s.loc}: phone=${s.phone} walkin=${s.walkin} web=${s.web}`));
process.exit(0);
