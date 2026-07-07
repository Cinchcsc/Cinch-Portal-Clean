// Verifies the assumption behind the new Autobill Conversion formula ("new autobilled customers /
// total new customers", per the legacy tooltip): that MoveInsAndMoveOuts rows expose a `TenantID`
// column so we can cross-reference against RentRoll's autobill flag. Also sanity-checks the actual
// numbers for one site.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-autobill-new.js
import { callReport } from '../lib/sitelink.js';

const loc = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean)[0];
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const end = new Date(now.getFullYear(), now.getMonth(), 0);

const { rows: mioRows } = await callReport('MoveInsAndMoveOuts', loc, start, end);
console.log(`site ${loc} · ${mioRows.length} move-in/out rows`);
console.log('COLUMNS:', Object.keys(mioRows[0] || {}).filter(k => !/^(diffgr|msdata)/i.test(k)).join(', '));

const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? ''));
const moveIns = mioRows.filter(r => yes(r.MoveIn));
console.log(`\n${moveIns.length} MoveIn=true rows. Do they have a TenantID?`, moveIns.slice(0, 5).map(r => r.TenantID));

const { rows: rrRows } = await callReport('RentRoll', loc, start, end);
const autobillIds = new Set(rrRows.filter(r => yes(r.bRented) && [1, 2].includes(Number(r.iAutoBillType))).map(r => String(r.TenantID)));
const newIds = moveIns.map(r => String(r.TenantID)).filter(Boolean);
const newAutobill = newIds.filter(id => autobillIds.has(id));
console.log(`\nnew customers with a TenantID: ${newIds.length} of ${moveIns.length}`);
console.log(`of those, on autobill: ${newAutobill.length}`);
console.log(`Autobill Conversion for this site: ${newIds.length ? (newAutobill.length / newIds.length * 100).toFixed(1) : 'n/a'}%`);
process.exit(0);
