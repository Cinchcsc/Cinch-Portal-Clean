// Dumps the REAL column names (+ row counts) for every report the portal uses, from one live
// call each, so the field mapping in reportMap.js can be finalised to match the live portal
// exactly (incl. the Self-Storage rate/ft² fix, which needs the unit-type column).
//
// Your Mac can reach SiteLink; the cloud sandbox cannot — so run this locally:
//   cd "sitelink-backend" && npm run dump:columns
//
// PII-safe: prints column NAMES for every report, but a sample ROW only for site-level
// aggregate reports (never for tenant-level lists).
import { listMethods, callReport } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter(k => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', '), '\nFill .env then: npm run dump:columns'); process.exit(1); }

const loc = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean)[0];
if (!loc) { console.error('SITELINK_LOCATIONS not set'); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);

// site-level aggregates — safe to show a sample row (no tenant PII)
const AGG = new Set(['OccupancyStatistics', 'ManagementSummary', 'FinancialSummary', 'MarketingSummary', 'MerchandiseSummary']);
const REPORTS = ['OccupancyStatistics', 'RentRoll', 'ManagementSummary', 'MoveInsAndMoveOuts', 'PastDueBalances',
  'ScheduledMoveOuts', 'InsuranceRoll', 'InsuranceActivity', 'InquiryTracking', 'MarketingSummary',
  'MerchandiseSummary', 'FinancialSummary', 'TenantRentChangeHistory'];

console.log('Connecting to SiteLink…');
try { const m = await listMethods(); console.log('✓ Connected.', m.length, 'SOAP methods available.\n'); }
catch (e) { console.error('✗ Connection/auth FAILED:', e.message, '\n(If this says Invalid API License Key / Ret_Code -89, the key is not registered for this integration.)'); process.exit(1); }

console.log(`Location ${loc} · period ${start.toISOString().slice(0, 10)} → ${now.toISOString().slice(0, 10)}\n`);
for (const method of REPORTS) {
  try {
    const { rows } = await callReport(method, loc, start, now);
    const cols = rows && rows[0] ? Object.keys(rows[0]) : [];
    console.log(`=== ${method} — ${rows ? rows.length : 0} rows ===`);
    console.log('COLUMNS:', cols.join(', ') || '(no rows returned)');
    if (AGG.has(method) && rows && rows[0]) console.log('SAMPLE :', JSON.stringify(rows[0]).slice(0, 1200));
    console.log('');
  } catch (e) {
    console.log(`=== ${method} — ERROR: ${e.message} ===\n`);
  }
}
process.exit(0);
