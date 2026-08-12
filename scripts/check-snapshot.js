// Read-only: shows exactly what's in snapshot_payload right now, plus the last few 'snapshot'-kind
// refresh_log rows (NO SiteLink calls, instant). ADDED 21 Jul 2026 (Michael: "i just ran the snapshot
// pull and git push, reservation and enquiries are still showing 0") — the raw-param bug fix
// (lib/pullSnapshot.js passing inq.raw into lead_funnel.parse(), commit 2e35d88) is confirmed present
// and confirmed pushed to origin/master, and reading through the rest of the chain (snapshotPayload.js
// -> app/api/snapshot/route.js -> page.js's fetchSnapshot()/statCards) didn't turn up a second bug —
// every field name and shape lines up. Can't query Supabase directly from this sandbox (no .env — see
// pullSnapshot.js's own "Run manually" note), so this is the fastest way to see the ACTUAL current
// numbers and settle whether (a) the manual pull didn't actually run/succeed, (b) it ran but the
// portfolio genuinely had ~0 enquiries in the window (implausible for 29 sites but checkable here),
// or (c) Supabase already has the right numbers and something downstream (browser cache, stale tab) is
// the real issue.
//   npm run check:snapshot
import { admin } from '../lib/supabaseAdmin.js';
import { retryOnStatementTimeout } from '../lib/supabaseRetry.js';
import { readSnapshotPayload } from '../lib/snapshotPayload.js';

try {
  let latestLoggedSnapshotRefreshAt = null;
  try {
    const logRows = await retryOnStatementTimeout(async () => {
      const { data, error } = await admin
        .from('refresh_log').select('id,kind,status,started_at,finished_at,detail')
        .eq('kind', 'snapshot').order('id', { ascending: false }).limit(5);
      if (error) throw new Error(error.message);
      return data || [];
    });

    console.log('=== last 5 snapshot pulls (refresh_log) ===');
    if (!logRows?.length) console.log('no snapshot-kind rows yet — has npm run pull:snapshot ever completed?');
    else for (const r of logRows) {
      const dur = r.finished_at ? Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 1000) + 's' : '(still running / never finished)';
      console.log(`#${r.id}  ${r.status?.padEnd(8) || '?'}  started ${r.started_at}  finished ${r.finished_at || '—'}  (${dur})`);
      if (r.detail) console.log(`     detail: ${r.detail.slice(0, 300)}`);
    }
    latestLoggedSnapshotRefreshAt = logRows.find((r) => r.status === 'ok')?.finished_at || logRows.find((r) => r.status === 'ok')?.started_at || null;
  } catch (error) {
    console.log('=== last 5 snapshot pulls (refresh_log) ===');
    console.log(`unable to read snapshot refresh_log rows: ${error.message}`);
  }

  console.log('\n=== current snapshot_payload row ===');
  let snapshot = null;
  try {
    snapshot = await readSnapshotPayload();
  } catch (error) {
    console.log(`unable to read full snapshot_payload row: ${error.message}`);
    const fallback = await retryOnStatementTimeout(async () => {
      const { data, error } = await admin
        .from('snapshot_payload').select('generated_at').eq('id', 1).maybeSingle();
      if (error) throw new Error(error.message);
      return data || null;
    });
    if (fallback?.generated_at) {
      console.log(`generated_at: ${fallback.generated_at}  (full payload body unavailable on this read; retry the command for full period/site detail)`);
      process.exit(0);
    }
    throw error;
  }
  if (!snapshot?.payload) { console.log('snapshot_payload: no row yet (id=1 not found) — pull:snapshot has never written successfully.'); process.exit(0); }

  const p = snapshot.payload;
  console.log(`generated_at: ${snapshot.generatedAt}  (snapshot_payload materialization time)`);
  if (latestLoggedSnapshotRefreshAt) {
    console.log(`latest successful snapshot refresh_log finish: ${latestLoggedSnapshotRefreshAt}`);
    if (snapshot.generatedAt && new Date(snapshot.generatedAt).getTime() > new Date(latestLoggedSnapshotRefreshAt).getTime()) {
      console.log('note: snapshot_payload is newer than the latest logged snapshot pull, which can happen because a fresh raw_report self-heal rewrote the stored row or because the hardened snapshot cron completed without writing refresh_log first.');
    }
  }
  for (const period of ['daily', 'weekly', 'quarterly']) {
    const w = p[period];
    if (!w) { console.log(`\n${period}: MISSING from payload`); continue; }
    console.log(`\n${period}  range ${w.range?.start} -> ${w.range?.end}  (${w.sites?.length || 0} sites)`);
    console.log(`  totals: enquiries=${w.totals?.enquiries}  reservations=${w.totals?.reservations}  moveIns=${w.totals?.moveIns}  moveOuts=${w.totals?.moveOuts}  sqftIn=${w.totals?.sqftIn}  sqftOut=${w.totals?.sqftOut}`);
    const nonZeroSites = (w.sites || []).filter((s) => s.enquiries || s.reservations);
    console.log(`  ${nonZeroSites.length}/${w.sites?.length || 0} sites have any nonzero enquiries/reservations`);
    if (nonZeroSites.length) console.log(`  e.g. ${nonZeroSites.slice(0, 3).map((s) => `${s.code}: enq=${s.enquiries} res=${s.reservations}`).join(', ')}`);
  }

  // ADDED 23 Jul 2026 (task #406/#409 verification) — the sample above only ever shows the first 3
  // nonzero-enquiries sites in whatever order `sites` comes back in, which may well never include
  // whichever specific site you're actually trying to check (e.g. Abingdon/L029 wasn't in it above).
  // Pass a site code to see its FULL row (incl. moveIns/moveOuts/sqftIn/sqftOut, not just enq/res) across
  // all three periods:  npm run check:snapshot -- L029
  const targetSite = process.argv[2];
  if (targetSite) {
    console.log(`\n=== ${targetSite} detail ===`);
    for (const period of ['daily', 'weekly', 'quarterly']) {
      const w = p[period];
      const s = w?.sites?.find((x) => x.code === targetSite);
      console.log(`  ${period}: ${s ? JSON.stringify(s) : `not found in ${period}.sites`}`);
    }
  }
  process.exit(0);
} catch (error) {
  console.log('snapshot verification failed after retries:', error.message);
  process.exit(1);
}
