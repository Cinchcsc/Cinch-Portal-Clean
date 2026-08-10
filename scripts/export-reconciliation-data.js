// Phase 3 (parallel run validation, 20 Jul 2026): exports current live "Ours" figures for the metrics
// already tracked in store_by_store_reconciliation.xlsx (Occupancy, Rate per ft2, Insurance Roll),
// plus Enquiries/Reservations (lead_funnel) since that parser had a real table-selection bug fixed
// today (task #325) and hasn't been re-checked against legacy with the corrected numbers yet.
//
// Reads the SAME fresh-current-month merged payload the live portal now serves, rather than the raw
// stored portal_payload row by itself. Since 27 Jul 2026 the app merges a live current-month slice
// from raw_report at read time; using the stored singleton directly here could make this
// reconciliation export disagree with the actual portal even when the portal is correct.
// Writes straight to a JSON file one level up from this repo (alongside the existing reconciliation
// spreadsheet/Go-Live Plan) so it doesn't need to be pasted into chat.
//
// Run: cd cinch-portal-clean && node --env-file=.env scripts/export-reconciliation-data.js
import { readPortalPayloadFreshCurrentMonth } from '../lib/portalPayload.js';
import { writeFileSync } from 'fs';

const result = await readPortalPayloadFreshCurrentMonth();
const payload = result?.payload;
if (!payload) { console.error('Fetch failed: no usable portal payload'); process.exit(1); }
const rows = payload.sites.map((s) => ({
  code: s.code,
  name: s.name,
  occ: s.occ, tot: s.tot, occPC: s.occPC,
  ssRate: s.ss?.rate ?? null, totalRate: s.rate, realRate: s.realRate,
  insuredUnits: s.insurance?.insured ?? 0, insurancePremium: s.insurance?.premium ?? 0,
  insurancePenetrationPC: s.insurance?.penetration ?? 0, occActualRent: s.occActualRent ?? 0,
  moveIns: s.moveIns ?? 0,
  moveOuts: s.moveOuts ?? 0,
  reservationsMade: s.reservationsMade ?? 0,
  enquiriesTotal: s.enquiries?.total ?? 0,
  reservationConversionBase: s.enquiries?.reservationConversionBase ?? s.enquiries?.total ?? 0,
  reservationConversions: s.enquiries?.reservationConversions ?? 0,
}));

const out = {
  exported_at: new Date().toISOString(),
  portal_generated_at: result?.generatedAt || payload.generated_at || null,
  current_month: payload.current_month,
  sites: rows,
};

const outPath = new URL('../../reconciliation-data.json', import.meta.url);
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${rows.length} site rows to ${outPath.pathname}`);
console.log(`portal payload generated_at: ${result?.generatedAt || payload.generated_at || null} (current_month: ${payload.current_month})`);
process.exit(0);
