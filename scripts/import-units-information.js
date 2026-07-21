// Back-compat wrapper for the newer floor-occupancy pull runner. Kept so any existing docs / shell
// history using `npm run import:units-information` still work after the auto-update wiring added
// 21 Jul 2026. The data path itself now lives in lib/pullFloorOccupancy.js and also runs from the
// daily cron route /api/pull-floor-occupancy.
//
// Usage:
//   node --env-file=.env scripts/import-units-information.js               # all SITELINK_LOCATIONS
//   node --env-file=.env scripts/import-units-information.js L001,L004     # explicit sites
import { runFloorOccupancyPull } from '../lib/pullFloorOccupancy.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) {
  console.error('Missing env:', miss.join(', '));
  process.exit(1);
}

const locations = (process.argv[2] || process.env.SITELINK_LOCATIONS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (!locations.length) {
  console.error('Usage: node --env-file=.env scripts/import-units-information.js <LOCATION[,LOCATION2,...]>');
  console.error('No locations provided and SITELINK_LOCATIONS is blank.');
  process.exit(1);
}

const result = await runFloorOccupancyPull({ locations });
console.log('FLOOR OCCUPANCY IMPORT RESULT:', JSON.stringify(result, null, 2));
process.exit(result.status === 'error' ? 1 : 0);
