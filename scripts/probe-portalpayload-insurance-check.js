// PROBE (27 Jul 2026), READ-ONLY — narrows down the insurance_roll live-portal discrepancy further.
// Confirmed so far: raw_report's SINGLE row for L001/2026-07 correctly holds insured_new_customers
// .count=25 (both stored and freshly re-parsed), and there's no duplicate/legacy-keyed row hiding a
// stale copy. Yet the live site (fetched via /api/portfolio in Chrome) shows count=0 for the same
// site, while a sibling field from the SAME source object (monthly_premium) reads through correctly.
//
// This checks the layer in between: what does the STORED portal_payload table itself hold for
// Bicester's insuredNewCustomers, right now -- bypassing the API route (and its Cache-Control:
// s-maxage=120/stale-while-revalidate=600 header) entirely. This tells us definitively which side
// the bug is on:
//   - If portal_payload ALREADY has count=25 for Bicester: the bug is purely in how /api/portfolio
//     serves it (likely: app/api/portfolio/route.js calls readPortalPayload({ ensureFresh: true }),
//     but readPortalPayload() takes NO parameters at all -- that options object is silently
//     discarded, so it always serves the plain last-rebuilt row, never a fresh live current-month
//     recompute, and Vercel's edge cache on top of that may still be serving an older response).
//   - If portal_payload ALSO shows count=0 (or missing) for Bicester: the bug is upstream, inside
//     buildPayload()/buildIndex()/recordFor() itself, and reparsing again won't fix it without a
//     code change.
//
// Run:  node --env-file=.env scripts/probe-portalpayload-insurance-check.js [siteName]
import { admin } from '../lib/supabaseAdmin.js';
import { decodePortalPayloadStorageValue } from '../lib/portalPayload.js';

const siteQuery = (process.argv[2] || 'Bicester').toLowerCase();

const { data, error } = await admin.from('portal_payload').select('payload,generated_at').eq('id', 1).maybeSingle();
if (error) { console.error('Fetch error:', error.message); process.exit(1); }
if (!data?.payload) { console.log('No portal_payload row found.'); process.exit(0); }

const payload = decodePortalPayloadStorageValue(data.payload);
console.log(`portal_payload generated_at: ${data.generated_at}`);
console.log(`current_month: ${payload.current_month}\n`);

const site = (payload.sites || []).find((s) => String(s.name || '').toLowerCase().includes(siteQuery));
if (!site) { console.log(`No site matching "${siteQuery}" found in payload.sites.`); process.exit(0); }

console.log(`Site: ${site.name}`);
console.log(`  moveIns: ${site.moveIns}`);
console.log(`  insurance (premium/insured/penetration): ${JSON.stringify(site.insurance)}`);
console.log(`  insuredNewCustomers: ${JSON.stringify(site.insuredNewCustomers)}`);
console.log(`\nCompare insuredNewCustomers.count above against raw_report's already-confirmed value (25 for L001/Bicester).`);
console.log(`Match => bug is in the /api/portfolio route/cache layer, not the rebuild. Mismatch => bug is in buildPayload() itself.`);
process.exit(0);
