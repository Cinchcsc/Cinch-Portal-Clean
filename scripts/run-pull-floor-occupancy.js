// Run the floor-level UnitsInformation import locally (writes unit_floor_status via the service-role
// key) so the KPI page's Occupancy by Floor widget can be refreshed outside the cron as needed.
import { runFloorOccupancyPull } from '../lib/pullFloorOccupancy.js';

const args = new Set(process.argv.slice(2));
const result = await runFloorOccupancyPull({
  triggerLabel: 'cli:npm-run-pull-floor-occupancy',
  skipLockCheck: args.has('--skip-lock-check'),
});
console.log('FLOOR OCCUPANCY PULL RESULT:', JSON.stringify(result, null, 2));
process.exit(result.status === 'error' ? 1 : 0);
