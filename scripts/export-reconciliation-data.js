// Phase 3 (parallel run validation, 20 Jul 2026): exports current live "Ours" figures for the metrics
// already tracked in store_by_store_reconciliation.xlsx (Occupancy, Rate per ft2, Insurance Roll),
// plus Enquiries/Reservations (lead_funnel) since that parser had a real table-selection bug fixed
// today (task #325) and hasn't been re-checked against legacy with the corrected numbers yet.
//
// Reads the ALREADY-FRESH portal_payload (no SiteLink calls, instant) rather than recomputing
// anything, so this reflects exactly what the live portal is showing right now. Writes straight to a
// JSON file one level up from this repo (alongside the existing reconciliation spreadsheet/Go-Live
// Plan) so it doesn't need to be pasted into chat.
//
// Run: cd cinch-portal-clean && node --env-file=.env scripts/export-reconciliation-data.js
import { admin } from '../lib/supabaseAdmin.js';
import { writeFileSync } from 'fs';

const { data, error } = await admin.from('portal_payload').select('payload,generated_at').eq('id', 1).single();
if (error) { console.error('Fetch failed:', error.message); process.exit(1); }

const { payload } = data;
const rows = payload.sites.map((s) => ({
  code: s.code,
  name: s.name,
  occ: s.occ, tot: s.tot, occPC: s.occPC,
  ssRate: s.ss?.rate ?? null, totalRate: s.rate, realRate: s.realRate,
  insuredUnits: s.insurance?.insured ?? 0, insurancePremium: s.insurance?.premium ?? 0,
  insurancePenetrationPC: s.insurance?.penetration ?? 0, occActualRent: s.occActualRent ?? 0,
  enquiriesTotal: s.enquiries?.total ?? 0,
  reservationConversionBase: s.enquiries?.reservationConversionBase ?? s.enquiries?.total ?? 0,
  reservationConversions: s.enquiries?.reservationConversions ?? 0,
}));

const out = {
  exported_at: new Date().toISOString(),
  portal_generated_at: data.generated_at,
  current_month: payload.current_month,
  sites: rows,
};

const outPath = new URL('../../reconciliation-data.json', import.meta.url);
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${rows.length} site rows to ${outPath.pathname}`);
console.log(`portal_payload generated_at: ${data.generated_at} (current_month: ${payload.current_month})`);
process.exit(0);
