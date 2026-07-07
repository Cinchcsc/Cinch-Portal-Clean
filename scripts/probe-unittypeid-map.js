// Checks whether RentRoll/OccupancyStatistics/RentalActivity rows expose a UnitTypeID field
// alongside their own type/size labels — if so, we can join ReservationList's UnitTypeID to a real
// unit type + area, to estimate "Reserved Scheduled Sqft". PII-SAFE: only prints column names,
// counts, and non-personal field values (unit type/size/area), never tenant name/phone/email.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-unittypeid-map.js
import { callReport } from '../lib/sitelink.js';

const now = new Date();
const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
const loc = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean)[0];

for (const method of ['RentRoll', 'OccupancyStatistics', 'RentalActivity']) {
  try {
    const { rows } = await callReport(method, loc, startOfMonth, now);
    console.log(`\n=== ${method} — ${rows.length} rows ===`);
    if (!rows.length) { console.log('(no rows)'); continue; }
    const cols = Object.keys(rows[0]);
    console.log('Columns:', cols.join(', '));
    const idCol = cols.find((c) => /unittypeid/i.test(c));
    console.log('Has a UnitTypeID-like column:', !!idCol, idCol || '');
    if (idCol) {
      const typeCol = cols.find((c) => /^(sTypeName|Type|UnitType)$/i.test(c));
      const sizeCol = cols.find((c) => /unitsize/i.test(c));
      const areaCol = cols.find((c) => /^area$/i.test(c));
      console.log('Sample rows (id/type/size/area):');
      for (const r of rows.slice(0, 8)) console.log({ [idCol]: r[idCol], type: typeCol && r[typeCol], size: sizeCol && r[sizeCol], area: areaCol && r[areaCol] });
    }
  } catch (e) { console.log(`${method} failed: ${e.message}`); }
}
