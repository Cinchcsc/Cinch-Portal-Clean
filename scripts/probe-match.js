// Reveals the Management Summary structure (drives debtors, move-ins, credits/discounts, merchandise,
// churn per the KPI doc) and the InquiryTracking email-domain split (to match R6's internal-email
// exclusion). PII-SAFE: dumps row labels + counts and email DOMAINS only — no names, no full emails.
//   npm run probe:match
import { callReport } from '../lib/sitelink.js';

const loc = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean)[0];
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const end = new Date(now.getFullYear(), now.getMonth(), 0);
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };

console.log(`=== ManagementSummary (${loc}, ${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}) — ALL rows ===`);
try {
  const { rows } = await callReport('ManagementSummary', loc, start, end);
  for (const r of rows) console.log(`[${String(r.SortID).padStart(3)}] ${String(r.sDesc).padEnd(30)} D=${r.iDCount}  M=${r.iMCount}  Y=${r.iYCount}`);
  console.log('(columns:', Object.keys(rows[0] || {}).filter(k => !/^(diffgr|msdata)/.test(k)).join(', '), ')');
} catch (e) { console.log('ERROR', e.message); }

console.log('\n=== InquiryTracking — channels + email domains (internal-filter check) ===');
try {
  const { rows } = await callReport('InquiryTracking', loc, start, end);
  const dom = {}, chan = {}; let conv = 0;
  for (const r of rows) {
    const e = String(r.sEmail || '').toLowerCase(); const d = e.includes('@') ? e.split('@')[1] : '(blank)';
    dom[d] = (dom[d] || 0) + 1;
    const c = String(r.sInquiryType || r.sCallType || '?'); chan[c] = (chan[c] || 0) + 1;
    if (num(r.iInquiryConvertedToLease) === 1) conv++;
  }
  console.log('total leads:', rows.length, ' converted:', conv);
  console.log('channels:', JSON.stringify(chan));
  console.log('email domains (count, desc):', JSON.stringify(Object.fromEntries(Object.entries(dom).sort((a, b) => b[1] - a[1]))));
} catch (e) { console.log('ERROR', e.message); }
process.exit(0);
