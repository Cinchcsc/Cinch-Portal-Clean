// Seeds the `sites` table (required before raw_report can reference it). No SiteLink calls — fast.
// Run once:  npm run init:sites
import { admin } from '../lib/supabaseAdmin.js';

// Kept in sync with lib/buildPayload.js's own NAMES constant — that copy is authoritative for
// DISPLAY (it overrides whatever's in the sites table, see buildPayload.js's `nameOf` build), but
// this one still matters for the sites table's own raw `name` column and any code that reads it
// directly. FIXED 8 Jul 2026: was missing L021 (Bedford) and L026 (Paulton) entirely — those two
// sites seeded with name=code until buildPayload.js's override masked it. Also ADDED L028 (Edmonton)
// and L029 (Abingdon) — two new sites Michael added to SITELINK_LOCATIONS 8 Jul 2026. Abingdon was
// previously a site the legacy portal tracked that we didn't (task #68); Edmonton doesn't appear in
// legacy's own per-site table at all, so — like Bedford/Paulton — it looks like a site we track that
// legacy doesn't (yet).
const NAMES = { L001: 'Bicester', L002: 'Leighton Buzzard', L003: 'Letchworth', L004: 'Chippenham',
  L005: 'Brighton', L006: 'Huntingdon', L007: 'Newmarket', L008: 'Enfield', L009: 'Newbury',
  L010: 'Mitcham', L011: 'Sittingbourne', L012: 'Gillingham', L013: 'Brentwood', L014: 'Earlsfield',
  L015: 'Watford', L016: 'Seaford', L017: 'Southend', L018: 'Woking', L019: 'Sidcup',
  L020: 'Dunstable', L021: 'Bedford', L022: 'Swindon', L023: 'Wisbech', L024: 'Newcastle',
  L025: 'Shoreham-By-Sea', L026: 'Paulton', L027: 'Exeter', L028: 'Edmonton', L029: 'Abingdon' };

const codes = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
if (!codes.length) { console.log('SITELINK_LOCATIONS is empty — nothing to seed.'); process.exit(1); }

console.log(`Seeding ${codes.length} sites…`);
const { data, error } = await admin
  .from('sites').upsert(codes.map(code => ({ code, name: NAMES[code] || code })), { onConflict: 'code' })
  .select('code');
if (error) {
  console.log('UPSERT FAILED:', JSON.stringify(error));
  console.log('\nIf this is a permissions/RLS error, the service-role key may not be the one in use,');
  console.log('or RLS needs a service-role bypass. Tell me the message above and I\'ll guide the fix.');
} else {
  console.log('Upsert OK — rows written:', data?.length ?? 0);
}

const { data: all, error: e2 } = await admin.from('sites').select('code,name');
if (e2) console.log('Read-back failed:', JSON.stringify(e2));
else console.log(`sites table now holds ${all.length} rows:`, all.map(s => s.code).join(', '));
process.exit(error ? 1 : 0);
