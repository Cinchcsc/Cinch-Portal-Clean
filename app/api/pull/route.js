// Vercel cron hits this route (see vercel.json). Vercel sends Authorization: Bearer $CRON_SECRET.
// Lives at /api/pull in the Next.js app.
import { NextResponse } from 'next/server';
import { runPull } from '../../../lib/pull.js';

export const runtime = 'nodejs';        // the SOAP client needs the Node runtime, not Edge
export const dynamic = 'force-dynamic';
// Explicitly declare the full serverless budget this pull needs. The pull is split across multiple
// cron entrypoints for operational reasons, but each invocation can still spend most of this window
// on its own SiteLink batch before control returns to Vercel.
export const maxDuration = 300;

// COST CONTROL: the full 17-report pull is ~500 SiteLink calls and won't finish inside a single 60s
// window even with 300s available split across multiple cron hits. So the daily cron runs a LIGHT set
// (occupancy + rent_roll, ~58 calls) to keep occupancy/rates fresh; the heavier flow reports
// (insurance, marketing, financials, debtors, …) run via the other 4 scheduled ?reports=... hits in
// vercel.json (each its own hour), or with ?full=1 for an ad-hoc all-reports pull (best on the Mac via
// `npm run pull`, no timeout). Add &reports=occupancy,past_due to pull any custom subset.
const LIGHT = ['occupancy', 'rent_roll'];

function statusCodeForJob(result) {
  switch (result?.status) {
    case 'ok':
      return 200;
    case 'skipped':
      return 409;
    case 'partial':
    case 'error':
      return 500;
    default:
      return 200;
  }
}

export async function GET(request) {
  // CHANGED 16 Jul 2026 (pentest follow-up): `if (secret && mismatch)` failed OPEN — skipped the
  // check entirely, letting anyone trigger a real SiteLink pull — if CRON_SECRET were ever unset.
  // Michael confirmed CRON_SECRET IS set in Vercel, and live-testing this route with no auth header
  // today correctly returned 401 (no pull triggered) — so this changes nothing about today's
  // behavior. `!secret` now means "treat as unauthorized" instead of "skip the check": a
  // misconfigured/missing secret blocks everyone (including the real cron, which would show up
  // loudly as a failing cron run in Vercel) instead of quietly opening the route to the world.
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const sp = new URL(request.url).searchParams;
    const triggerLabel = (() => {
      const u = new URL(request.url);
      const ua = (request.headers.get('user-agent') || 'unknown').replace(/\s+/g, ' ').trim();
      return `${u.pathname}${u.search || ''} ua=${ua}`;
    })();
    const full = sp.get('full') === '1';
    const custom = (sp.get('reports') || '').split(',').map(s => s.trim()).filter(Boolean);
    const reports = custom.length ? custom : (full ? undefined : LIGHT);  // undefined => all reports
    // SITE SHARDING (task #327 follow-up, 20 Jul 2026) — optional ?shard=N&shards=M to run only every
    // Mth site (0-based index) in this invocation. See lib/pull.js's runPull() comment for why
    // (true_revenue alone still exceeded 300s even after removing its batch-mates; vercel.json now
    // splits it 4 ways across separate hours using this).
    const shards = sp.get('shards') ? Number(sp.get('shards')) : undefined;
    const shard = sp.get('shard') ? Number(sp.get('shard')) : 0;
    // rebuildPayload:false (task #297 fix, 17 Jul 2026) — every cron hit of THIS route is time-boxed
    // to the same 300s maxDuration as its own SiteLink calls; appending the portal_payload rebuild here
    // too is what's been dying mid-rebuild on the day's last batch (see lib/pull.js's rebuildPayload
    // comment). The rebuild now happens exclusively via /api/rebuild-payload's own dedicated cron, with
    // its own untouched budget, after every report-pulling batch has had its own hour to finish.
    const result = await runPull({ reports, rebuildPayload: false, shard, shards, triggerLabel });
    return NextResponse.json(result, { status: statusCodeForJob(result) });
  } catch (e) {
    return NextResponse.json({ status: 'error', message: e.message }, { status: 500 });
  }
}
