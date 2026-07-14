// One-off comparison: legacy portal's July 2026 Move-ins & Move-outs card (screenshot shared by
// Michael, 14 Jul 2026: 445 move-ins, 296 move-outs, 9,539 net ft²) vs our own July 2026 figures —
// EXCLUDING Bedford (L021), Paulton (L026), Edmonton (L028), since Michael confirmed the legacy
// portal doesn't track those three (same known scope gap as task #68/#69). Read-only, no writes —
// uses already-stored raw_report data via buildPayloadRange(), same as the live /api/portfolio route.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/compare-legacy-july2026.js
import { buildPayloadRange } from '../lib/buildPayload.js';

const LEGACY_EXCLUDED = new Set(['L021', 'L026', 'L028']); // Bedford, Paulton, Edmonton

const LEGACY = { moveIns: 445, moveOuts: 296, netArea: 9539 };

const july = new Date(2026, 6, 1); // July 2026 (month is 0-indexed)
const payload = await buildPayloadRange(july, july);

if (!payload.sites?.length) {
  console.log('No sites returned for July 2026 — is raw_report populated for this month yet?');
  process.exit(0);
}

const included = payload.sites.filter((s) => !LEGACY_EXCLUDED.has(s.code));
const excluded = payload.sites.filter((s) => LEGACY_EXCLUDED.has(s.code));

const sum = (arr, key) => arr.reduce((a, s) => a + (s[key] || 0), 0);
const ours = {
  moveIns: sum(included, 'moveIns'),
  moveOuts: sum(included, 'moveOuts'),
  netArea: sum(included, 'netArea'),
};
const oursAll29 = {
  moveIns: sum(payload.sites, 'moveIns'),
  moveOuts: sum(payload.sites, 'moveOuts'),
  netArea: sum(payload.sites, 'netArea'),
};

console.log('=== July 2026 — Move-ins & Move-outs: legacy vs ours ===\n');
console.log(`Sites excluded to match legacy's scope: ${excluded.map((s) => `${s.code} (${s.name})`).join(', ') || '(none found — check codes)'}\n`);

console.log('                Legacy      Ours (26 sites, matching scope)    Diff');
for (const key of ['moveIns', 'moveOuts', 'netArea']) {
  const diff = ours[key] - LEGACY[key];
  console.log(`${key.padEnd(12)}  ${String(LEGACY[key]).padStart(8)}      ${String(ours[key]).padStart(8)}                        ${diff >= 0 ? '+' : ''}${diff}`);
}

console.log('\n(For reference) Ours across all 29 tracked sites, including Bedford/Paulton/Edmonton:');
console.log(`  moveIns=${oursAll29.moveIns}  moveOuts=${oursAll29.moveOuts}  netArea=${oursAll29.netArea}`);
console.log(`  (the 3 excluded sites alone: moveIns=${sum(excluded, 'moveIns')}  moveOuts=${sum(excluded, 'moveOuts')}  netArea=${sum(excluded, 'netArea')})`);

process.exit(0);
