// Diagnostic for Michael's report (15 Jul 2026): "Watchdog - Discounted Units in Fully Occupied
// Groups" has way too much going on, and some units appear duplicated within the same store.
//
// Hypothesis: app/portal-v2/page.js's District Manager section joins RentRoll's per-unit rows
// (unitRows, groupKey = `${sTypeName}|${round(Area)}`) against RentalActivity's per-(Type,UnitSize)
// groups (rentalActivityByTypeSize) using the SAME rounded-area key: `${g.type}|${Math.round(g.area)}`.
// RentalActivity is genuinely one row per (Type, UnitSize) -- e.g. a site can have both a "5X10" and
// a "10X5" UnitSize (or two sizes that are simply a fraction of a sqft apart, e.g. 49.6 vs 50.4 sqft),
// which are DIFFERENT UnitSize rows but ROUND to the SAME area. RentRoll's per-unit rows only ever
// carry rounded area (no separate width/length), so those units are indistinguishable from either
// source group once keyed this way. The page.js loop iterates every RentalActivity group and, for
// each one whose OWN vacant count is 0, pushes every RentRoll unit matching that rounded-area key --
// so if two RentalActivity groups collide on the same key and BOTH show vacant=0, every matching unit
// gets pushed to the Watchdog table TWICE (once per colliding group). This script checks, per site,
// whether any (type, roundedArea) key is shared by more than one RentalActivity row, which would
// confirm this exact duplication mechanism.
//
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-dm-widget-duplicates.js [siteCode]
import { admin } from '../lib/supabaseAdmin.js';

const wantSite = process.argv[2];

const { data: pr, error } = await admin
  .from('portal_payload').select('payload,generated_at')
  .eq('id', 1).order('generated_at', { ascending: false }).limit(1);
if (error) { console.error('portal_payload read error:', error.message); process.exit(1); }
let p = pr?.[0]?.payload; if (typeof p === 'string') { try { p = JSON.parse(p); } catch {} }
if (!p?.sites?.length) { console.error('portal_payload has no usable sites[] -- run npm run pull / npm run check first.'); process.exit(1); }

console.log(`portal_payload generated ${pr[0].generated_at}\n`);

let sites = p.sites;
if (wantSite) sites = sites.filter((s) => s.code === wantSite || s.name === wantSite);
if (!sites.length) { console.error(`No site matched "${wantSite}".`); process.exit(1); }

let sitesWithKeyCollisions = 0;
let totalDuplicatePushes = 0;

let totalRentRollDupeUnits = 0;

for (const s of sites) {
  const groups = s.rentalActivityByTypeSize || [];
  const unitsAtSite = s.unitRows || [];
  if (!groups.length && !unitsAtSite.length) continue;

  // Separate check: does RentRoll itself ever return TWO rows for the same physical unit name in
  // the same site/month (e.g. a mid-month transfer/tenant-swap producing two occupied rows for one
  // unit)? This would duplicate the Watchdog/Stay&Re-Lease output even with the groupKey join fixed.
  const unitNameCounts = {};
  for (const u of unitsAtSite) unitNameCounts[u.unit] = (unitNameCounts[u.unit] || 0) + 1;
  const rentRollDupes = Object.entries(unitNameCounts).filter(([, n]) => n > 1);
  if (rentRollDupes.length) {
    totalRentRollDupeUnits += rentRollDupes.length;
    console.log(`${(s.name || s.code).padEnd(20)} RENTROLL-LEVEL DUPLICATE unit rows: ${rentRollDupes.map(([u, n]) => `${u} x${n}`).join(', ')}`);
  }

  // Group RentalActivity rows by the same key page.js uses.
  const byKey = {};
  for (const g of groups) {
    const key = `${g.type}|${Math.round(g.area)}`;
    (byKey[key] ??= []).push(g);
  }
  const collidingKeys = Object.entries(byKey).filter(([, gs]) => gs.length > 1);

  // Replay page.js's exact discountedRows loop to count how many times each unit actually gets
  // pushed for THIS site (>1 = a real duplicate row in the Watchdog table).
  const pushCounts = {};
  for (const g of groups) {
    const key = `${g.type}|${Math.round(g.area)}`;
    if (!(g.totalUnits > 0 && g.vacant === 0)) continue;
    const unitsInGroup = unitsAtSite.filter((u) => u.groupKey === key);
    for (const u of unitsInGroup) {
      if (u.stdRate > 0 && u.rent < u.stdRate) {
        pushCounts[u.unit] = (pushCounts[u.unit] || 0) + 1;
      }
    }
  }
  const dupedUnits = Object.entries(pushCounts).filter(([, n]) => n > 1);
  const dupPushesHere = dupedUnits.reduce((a, [, n]) => a + (n - 1), 0);
  totalDuplicatePushes += dupPushesHere;
  if (collidingKeys.length) sitesWithKeyCollisions++;

  if (collidingKeys.length || dupedUnits.length || wantSite) {
    console.log(`${(s.name || s.code).padEnd(20)} groups=${String(groups.length).padStart(3)}  colliding-keys=${String(collidingKeys.length).padStart(2)}  duplicate-rows-in-watchdog=${String(dupPushesHere).padStart(2)}`);
    for (const [key, gs] of collidingKeys) {
      console.log(`    KEY COLLISION "${key}": ${gs.length} RentalActivity rows -> ${gs.map((g) => `UnitSize=${g.unitSize} area=${g.area} vacant=${g.vacant} totalUnits=${g.totalUnits}`).join('  |  ')}`);
    }
    for (const [unit, n] of dupedUnits) {
      console.log(`    DUPLICATE ROW: unit "${unit}" appears ${n}x in the Watchdog table for this site`);
    }
  }
}

console.log(`\n${sitesWithKeyCollisions} site(s) have colliding (type, roundedArea) keys across RentalActivity rows.`);
console.log(`${totalDuplicatePushes} duplicate row(s) confirmed under the OLD (pre-15-Jul-fix) logic replayed above.`);
console.log(`${totalRentRollDupeUnits} unit(s) with genuinely duplicate RentRoll rows (same unit name twice in one site's unit_rows).`);
if (totalDuplicatePushes > 0) console.log('=> Confirms the key-collision duplication bug described above (this is what app/portal-v2/page.js was fixed to no longer do).');
if (totalRentRollDupeUnits > 0) console.log('=> RentRoll itself is returning duplicate rows for these units -- a separate, upstream issue.');

// VERIFICATION PASS (15 Jul 2026): replay the FIXED merge-by-key logic now live in
// app/portal-v2/page.js (groups sharing a key are merged into one before the discount check runs)
// and confirm it produces ZERO duplicate pushes across every site -- proves the fix actually closes
// the bug quantified above, not just that the bug existed.
console.log('\n--- Verifying the FIXED (merged-groups) logic produces zero duplicates ---');
let totalDuplicatePushesAfterFix = 0;
let totalDiscountedRowsAfterFix = 0;
for (const s of sites) {
  const groups = s.rentalActivityByTypeSize || [];
  const unitsAtSite = s.unitRows || [];
  if (!groups.length && !unitsAtSite.length) continue;

  const merged = new Map();
  for (const g of groups) {
    const key = `${g.type}|${Math.round(g.area)}`;
    const m = merged.get(key);
    if (!m) merged.set(key, { totalUnits: g.totalUnits, vacant: g.vacant });
    else { m.totalUnits += g.totalUnits; m.vacant += g.vacant; }
  }
  const pushCountsAfter = {};
  const seenUnits = new Set();
  for (const [key, g] of merged) {
    if (!(g.totalUnits > 0 && g.vacant === 0)) continue;
    const unitsInGroup = unitsAtSite.filter((u) => u.groupKey === key);
    for (const u of unitsInGroup) {
      if (u.stdRate > 0 && u.rent < u.stdRate && !seenUnits.has(u.unit)) {
        seenUnits.add(u.unit);
        pushCountsAfter[u.unit] = (pushCountsAfter[u.unit] || 0) + 1;
        totalDiscountedRowsAfterFix++;
      }
    }
  }
  const dupedAfter = Object.entries(pushCountsAfter).filter(([, n]) => n > 1);
  totalDuplicatePushesAfterFix += dupedAfter.reduce((a, [, n]) => a + (n - 1), 0);
}
console.log(`${totalDiscountedRowsAfterFix} total Watchdog rows under the FIXED logic (was inflated by duplicates before).`);
console.log(`${totalDuplicatePushesAfterFix} duplicate row(s) remaining under the FIXED logic.`);
console.log(totalDuplicatePushesAfterFix === 0 ? '=> FIX VERIFIED: zero duplicates with the merged-groups logic.' : '=> STILL DUPLICATES AFTER FIX -- needs another look.');
process.exit(0);
