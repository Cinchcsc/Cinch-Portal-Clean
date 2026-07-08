// Pushing further on the Walk-ins gap (8 Jul 2026) after probe-walkin-label-dump.js ruled out a
// label collision — ManagementSummary's "Walk-In Leads" row is clean and unambiguous, our regex
// grabs it correctly, so 76 is a verbatim SiteLink counter, not a parsing bug. Three remaining,
// genuinely untried angles, all using our EXISTING SiteLink API access (no UI/credentials needed):
//
// 1. InquiryTracking's OWN walk-in count (sInquiryType) for JULY specifically — we only ever checked
//    this ratio for JUNE (probe:enquiries-gap2: Phone 102/2.3%, Walk-in 78/1.8%, Web 4225/95.7%,
//    badly undercounting walk-in vs legacy's June 233). Never re-checked for July's MTD window.
// 2. MarketingSummary's per-source breakdown (sMarketingDesc) — a THIRD, never-checked report that
//    groups by named marketing channel. If it has a "Walk-In"-labeled row, its own count is a fresh
//    data point independent of both ManagementSummary and InquiryTracking.
// 3. A day-by-day granularity check on ManagementSummary itself, for a few sites: does calling it once
//    for Jul 1-8 give the same Walk-In Leads total as calling it 8 times (Jul 1-1, Jul 2-2, ... Jul
//    8-8) and summing? If not, the API handles custom multi-day ranges differently than we assume —
//    a real mechanism bug, not a definitional difference with legacy.
// PII-SAFE: aggregated counts and source labels only.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-walkin-deeper.js
import { callReport } from '../lib/sitelink.js';
import { REPORTS } from '../lib/reportMap.js';

const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
if (!locations.length) { console.error('SITELINK_LOCATIONS not set'); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
let end = new Date(); if (end > now) end = now;

// --- 1. InquiryTracking's own walk-in count for July MTD ---
console.log('=== 1. InquiryTracking (sInquiryType) walk-in count, Jul 2026 MTD ===');
let ipPhone = 0, ipWalk = 0, ipWeb = 0, ipEmail = 0;
for (const loc of locations) {
  process.stderr.write(`[deeper:1] ${loc}...\n`);
  try {
    const { rows } = await callReport('InquiryTracking', loc, start, end);
    const p = REPORTS.lead_funnel.parse(rows);
    ipPhone += p.phone; ipWalk += p.walkin; ipWeb += p.web; ipEmail += p.email;
  } catch (e) { console.log(`  ${loc}: error: ${e.message}`); }
}
console.log(`Phone=${ipPhone}  Walk-in=${ipWalk}  Web=${ipWeb}  Email=${ipEmail}`);
console.log(`(for reference: ManagementSummary gave Walk-in=76, legacy shows 60)\n`);

// --- 2. MarketingSummary per-source breakdown ---
console.log('=== 2. MarketingSummary sMarketingDesc sources, Jul 2026 MTD (any "walk"-labeled source?) ===');
const sourceTotals = {};
for (const loc of locations) {
  process.stderr.write(`[deeper:2] ${loc}...\n`);
  try {
    const { rows } = await callReport('MarketingSummary', loc, start, end);
    const p = REPORTS.marketing.parse(rows);
    for (const s of p.sources) {
      const k = s.source || '(blank)';
      const t = (sourceTotals[k] ??= { tenants: 0, moveins: 0 });
      t.tenants += s.tenants || 0; t.moveins += s.moveins || 0;
    }
  } catch (e) { console.log(`  ${loc}: error: ${e.message}`); }
}
const sorted = Object.entries(sourceTotals).sort((a, b) => b[1].tenants - a[1].tenants);
for (const [k, v] of sorted) console.log(`  "${k}"  tenants=${v.tenants}  moveins=${v.moveins}${/walk/i.test(k) ? '  <-- matches /walk/i' : ''}`);
if (!sorted.some(([k]) => /walk/i.test(k))) console.log('  (no source label matched /walk/i — MarketingSummary tracks move-in attribution, not raw leads, so this is expected)');
console.log();

// --- 3. Day-by-day granularity check, 3 sites ---
console.log('=== 3. Day-by-day vs one multi-day call — ManagementSummary Walk-In Leads, 3 sites ===');
const sampleSites = locations.slice(0, 3);
for (const loc of sampleSites) {
  const { rows: multiRows } = await callReport('ManagementSummary', loc, start, end);
  const multiWalk = REPORTS.management.parse(multiRows).walkin_leads || 0;
  let dayWalkSum = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dayStart = new Date(d), dayEnd = new Date(d);
    process.stderr.write(`[deeper:3] ${loc} ${dayStart.toISOString().slice(0, 10)}...\n`);
    try {
      const { rows } = await callReport('ManagementSummary', loc, dayStart, dayEnd);
      dayWalkSum += REPORTS.management.parse(rows).walkin_leads || 0;
    } catch (e) { console.log(`    ${loc} ${dayStart.toISOString().slice(0, 10)}: error: ${e.message}`); }
  }
  console.log(`  ${loc}: one Jul1-8 call = ${multiWalk}   vs   sum of 8 single-day calls = ${dayWalkSum}${multiWalk !== dayWalkSum ? '  <-- MISMATCH' : '  (match)'}`);
}
process.exit(0);
