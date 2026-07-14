// Run the Cockpit Charting daily pull locally (no Vercel timeout). One FinancialSummary call per
// site (29 calls) — writes one row per site to daily_financial_snapshot via the service-role key.
// npm run pull:cockpit
import { runCockpitPull } from '../lib/pullCockpit.js';

const result = await runCockpitPull();
console.log('COCKPIT PULL RESULT:', JSON.stringify(result, null, 2));
process.exit(result.status === 'error' ? 1 : 0);
