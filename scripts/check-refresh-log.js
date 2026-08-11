// Read-only: dumps the most recent refresh_log rows (NO SiteLink calls, instant) — this is the
// table every cron/pull writes a 'running' row into on start and updates to 'ok'/'error'/'partial'
// on finish (see lib/pullLock.js). ADDED 15 Jul 2026 (Michael: "is there a different way you can
// confirm the auto updates" — I don't have Supabase/Vercel credentials in my own sandbox, so this
// is the quickest way to check whether the daily crons actually fired and succeeded, without waiting
// on the portal UI to reflect it).
//
// Note: all /api/pull?reports=... cron slots share kind='pull' (they call the same
// runPull() with different `reports` overrides) — there's no per-slot label stored, so distinguish
// them by started_at falling in separate hours, not by kind. Read vercel.json for the current UTC
// schedule rather than trusting any hardcoded hour list here.
//   npm run check:refresh-log
import { admin } from '../lib/supabaseAdmin.js';
import { retryOnStatementTimeout } from '../lib/supabaseRetry.js';
import { readFileSync } from 'fs';

async function withTimeout(promise, timeoutMs, label) {
  let timeoutId = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

try {
  try {
    const data = await withTimeout(
      retryOnStatementTimeout(async () => {
        const { data, error } = await admin
          .from('refresh_log').select('id,kind,status,started_at,finished_at,detail')
          .order('id', { ascending: false }).limit(20);
        if (error) throw new Error(error.message);
        return data || [];
      }),
      20000,
      'recent refresh_log read',
    );

    if (!data.length) { console.log('refresh_log: no rows yet.'); process.exit(0); }

    console.log('id     kind       status     started_at                finished_at               duration');
    console.log('----------------------------------------------------------------------------------------------');
    for (const r of data) {
      const dur = r.finished_at ? Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 1000) + 's' : '(running)';
      console.log(
        `${String(r.id).padEnd(6)} ${(r.kind || '?').padEnd(10)} ${(r.status || '?').padEnd(10)} ${r.started_at.padEnd(25)} ${(r.finished_at || '').padEnd(25)} ${dur}`
      );
      if (r.detail) console.log(`       detail: ${r.detail.slice(0, 400)}`);
    }
  } catch (error) {
    console.log(`unable to read recent refresh_log rows: ${error.message}`);
  }

  const now = new Date();
  const cycleStart = new Date(now);
  cycleStart.setUTCHours(0, 0, 0, 0);
  let expectedRows = null;
  try {
    const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
    expectedRows = Array.isArray(vercel?.crons) ? vercel.crons.length : null;
  } catch {}

  const expectation = expectedRows == null
    ? 'expected count unavailable'
    : `expect at least ${expectedRows} scheduled row(s) once the full cycle has run`;

  try {
    const cycleRows = await withTimeout(
      retryOnStatementTimeout(async () => {
        const { data, error } = await admin
          .from('refresh_log').select('id,kind,status,started_at')
          .gte('started_at', cycleStart.toISOString());
        if (error) throw new Error(error.message);
        return data || [];
      }),
      20000,
      'current-cycle refresh_log summary read',
    );
    console.log(`\n${cycleRows.length} row(s) started in the current overnight cycle (since ${cycleStart.toISOString()}) — ${expectation}. Higher counts usually mean manual reruns or catch-up tests happened during the same cycle.`);
  } catch (error) {
    console.log(`\nunable to read current-cycle refresh_log summary: ${error.message} — ${expectation}.`);
  }
  process.exit(0);
} catch (error) {
  console.log('refresh_log verification failed after retries:', error.message);
  process.exit(1);
}
