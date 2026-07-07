// Temporarily pin portal_payload's "current month" to a specific CLOSED month (default: June 2026),
// so every widget — including the ones that normally stay live to the in-progress month (Occupancy,
// Rate/ft², Debtor Levels, Reservations, Reserved Scheduled Sqft) — shows that one locked, consistent
// month instead of a mix of "June flow metrics + live July snapshots". Michael's ask (6 Jul 2026):
// while actively reviewing/QA-ing the portal, having numbers shift between refreshes (because July is
// still live) makes it hard to tell a real bug from normal mid-month drift — pinning everything to
// June removes that variable.
// Does NOT touch raw_report or call SiteLink — reuses whatever is already stored (instant, like
// `npm run rebuild`), and does NOT change pull.js/rebuild.js's normal current-month-live default —
// the next plain `npm run pull` or `npm run rebuild` flips straight back to live July. This is a
// one-off override, not a permanent behavior change.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/rebuild-as-of.js [YYYY-MM]
// Example: node --env-file=.env scripts/rebuild-as-of.js 2026-06
import { admin } from '../lib/supabaseAdmin.js';
import { buildPayload } from '../lib/buildPayload.js';

const monthArg = process.argv[2] || '2026-06';
const [y, m] = monthArg.split('-').map(Number);
const cur = new Date(y, m - 1, 1);        // pinned "current" month (June)
const prev = new Date(y, m - 2, 1);       // its own previous complete month (May) — drives MoM deltas

const payload = await buildPayload(cur, prev);
const { error } = await admin.from('portal_payload').upsert({ id: 1, generated_at: new Date().toISOString(), payload });
if (error) { console.error('rebuild-as-of failed:', error.message); process.exit(1); }
console.log(`Payload pinned to ${monthArg} — ${payload.months.length} months stored, ${payload.sites.length} sites, current_month=${payload.current_month}.`);
console.log('NOTE: every widget (including the normally-live ones) now shows this month. Run `npm run rebuild` to go back to live current-month behavior.');
process.exit(0);
