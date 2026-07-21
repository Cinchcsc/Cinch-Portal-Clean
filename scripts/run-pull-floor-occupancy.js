// Run the floor-level UnitsInformation import locally (writes unit_floor_status via the service-role
// key) so the KPI page's Occupancy by Floor widget can be refreshed outside the cron as needed.
import { runFloorOccupancyPull } from '../lib/pullFloorOccupancy.js';

const result = await runFloorOccupancyPull();
console.log('FLOOR OCCUPANCY PULL RESULT:', JSON.stringify(result, null, 2));
process.exit(result.status === 'error' ? 1 : 0);
