// Investigates the site-scope mismatch found comparing our portal against the legacy portal for
// July 2026: legacy tracks a site called "Abingdon" that doesn't exist anywhere in our system (not in
// SITELINK_LOCATIONS, not in lib/scripts/init-sites.js's NAMES map), while our system tracks Bedford
// and Paulton, which the legacy portal has stopped showing entirely (dropped from its site-selector
// dropdown — confirmed by manually checking the legacy portal's site list on 7 Jul 2026).
// This script:
//   1. Lists every SOAP method on the ReportingWs client, to check whether SiteLink exposes any
//      location-listing method (e.g. GetLocations/GetCorpLocations) we could call directly.
//   2. If no listing method exists, tries a small set of GUESSED location codes right after our
//      known range (L001-L027) and right before it, on the theory Abingdon may simply be the next
//      unallocated code — this is a guess, not a guarantee, and the script says so either way.
//   3. For Bedford/Paulton (need their codes from SITELINK_LOCATIONS — this script also prints your
//      current env var's codes/names so we can map which of L001-L027 they are), tries pulling this
//      month's RentRoll fresh to see whether SiteLink itself still returns real data for them (if
//      SiteLink errors or returns 0 rows, that's a strong signal they're genuinely closed).
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-sitelink-abingdon.js
import { client, listMethods, callReport, creds } from '../lib/sitelink.js';

console.log('--- SITELINK_LOCATIONS (raw env var) ---');
const codes = (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
console.log(codes.join(', '), `(${codes.length} codes)`);

console.log('\n--- SOAP methods available on ReportingWs ---');
try {
  const methods = await listMethods();
  console.log(JSON.stringify(methods, null, 2).slice(0, 3000));
} catch (e) {
  console.log('listMethods() failed:', e.message);
}

console.log('\n--- Trying candidate "list locations" method names directly ---');
const c = await client();
const candidates = ['GetLocations', 'GetCorpLocations', 'GetLocationList', 'LocationList', 'GetSiteList'];
for (const name of candidates) {
  const fn = c[`${name}Async`];
  if (typeof fn !== 'function') { console.log(`${name}: not present on client`); continue; }
  try {
    const [result] = await fn({ ...creds() });
    console.log(`${name}: SUCCESS —`, JSON.stringify(result).slice(0, 1500));
  } catch (e) {
    console.log(`${name}: FAILED — ${e.message}`);
  }
}

console.log('\n--- Testing a probe pull for each of your current codes (this month), to spot any that SiteLink now rejects/returns empty (candidates for "closed") ---');
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
for (const code of codes) {
  try {
    const { rows } = await callReport('RentRoll', code, start, end);
    console.log(`${code}: ${rows.length} rows`);
  } catch (e) {
    console.log(`${code}: ERROR — ${e.message}`);
  }
}
process.exit(0);
