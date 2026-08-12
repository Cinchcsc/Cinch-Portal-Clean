// Read-only: dumps the most recent refresh_log rows (NO SiteLink calls, instant) — this is the
// table every cron/pull writes a 'running' row into on start and updates to 'ok'/'error'/'partial'
// on finish (see lib/pullLock.js). ADDED 15 Jul 2026 (Michael: "is there a different way you can
// confirm the auto updates" — I don't have Supabase/Vercel credentials in my own sandbox, so this
// is the quickest way to check whether the daily crons actually fired and succeeded, without waiting
// on the portal UI to reflect it).
//
// Note: all /api/pull?reports=... cron slots still share kind='pull', but the cron/manual routes now
// stamp `trigger=...` into refresh_log.detail, so we can compare actual logged runs against the
// current vercel.json schedule directly instead of guessing by hour alone.
//   npm run check:refresh-log
import { admin } from '../lib/supabaseAdmin.js';
import { retryOnStatementTimeout } from '../lib/supabaseRetry.js';
import { readFileSync } from 'fs';

const NEARBY_UNLABELLED_WINDOW_MS = 75 * 60 * 1000;
const DEFAULT_PULL_REPORTS = ['occupancy', 'rent_roll'];

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

function parseScheduledUtcSlots(crons, now) {
  return (Array.isArray(crons) ? crons : [])
    .map((cron) => {
      const path = String(cron?.path || '').trim();
      const schedule = String(cron?.schedule || '').trim();
      const parts = schedule.split(/\s+/);
      if (!path || parts.length !== 5) return null;
      const [minute, hour, dom, month, dow] = parts;
      if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour) || dom !== '*' || month !== '*' || dow !== '*') return null;
      const scheduledAt = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        Number(hour),
        Number(minute),
        0,
        0,
      ));
      return { path, schedule, scheduledAt };
    })
    .filter(Boolean)
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
}

function triggerNeedles(path) {
  const raw = String(path || '').trim();
  if (!raw) return [];
  const out = new Set([`trigger=${raw}`]);
  try {
    const u = new URL(raw, 'https://example.invalid');
    const normalized = `${u.pathname}${u.searchParams.toString() ? `?${u.searchParams.toString()}` : ''}`;
    out.add(`trigger=${normalized}`);
  } catch {}
  return [...out];
}

async function readSnapshotPayloadGeneratedAt() {
  const { data, error } = await admin
    .from('snapshot_payload')
    .select('generated_at')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.generated_at || null;
}

async function readPortalPayloadGeneratedAt() {
  const { data, error } = await admin
    .from('portal_payload')
    .select('generated_at')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.generated_at || null;
}

async function readLatestCockpitMaterializedAt() {
  const { data, error } = await admin
    .from('daily_financial_snapshot')
    .select('pulled_at')
    .order('pulled_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.pulled_at || null;
}

async function readLatestFloorMaterializedAt() {
  const { data, error } = await admin
    .from('unit_floor_status')
    .select('imported_at')
    .order('imported_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.imported_at || null;
}

function reportsForPullPath(path) {
  try {
    const url = new URL(path, 'https://example.invalid');
    const reports = (url.searchParams.get('reports') || '')
      .split(',')
      .map((report) => report.trim())
      .filter(Boolean);
    return reports.length ? reports : DEFAULT_PULL_REPORTS;
  } catch {
    return DEFAULT_PULL_REPORTS;
  }
}

async function readLatestRawReportPulledAtForPath(path) {
  const reports = reportsForPullPath(path);
  const { data, error } = await admin
    .from('raw_report')
    .select('pulled_at')
    .in('report', reports)
    .order('pulled_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.pulled_at || null;
}

async function readDestinationEvidenceAt(path) {
  if (path === '/api/pull-snapshot' || path === '/api/pull-snapshot-retry') return readSnapshotPayloadGeneratedAt();
  if (
    path === '/api/rebuild-payload' ||
    path === '/api/rebuild-payload-0350' ||
    path === '/api/rebuild-payload-05' ||
    path === '/api/rebuild-payload-09' ||
    path === '/api/rebuild-payload-14' ||
    path === '/api/rebuild-payload-15'
  ) return readPortalPayloadGeneratedAt();
  if (path === '/api/pull-cockpit' || path === '/api/pull-cockpit-retry') return readLatestCockpitMaterializedAt();
  if (path === '/api/pull-floor-occupancy' || path === '/api/pull-floor-occupancy-retry') return readLatestFloorMaterializedAt();
  if (path.startsWith('/api/pull')) return readLatestRawReportPulledAtForPath(path);
  return null;
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
  let vercelCrons = null;
  try {
    const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
    vercelCrons = Array.isArray(vercel?.crons) ? vercel.crons : null;
  } catch {}
  const expectedRows = vercelCrons?.length ?? null;

  const expectation = expectedRows == null
    ? 'expected count unavailable'
    : `expect at least ${expectedRows} scheduled row(s) once the full cycle has run`;

  try {
    const cycleRows = await withTimeout(
      retryOnStatementTimeout(async () => {
        const { data, error } = await admin
          .from('refresh_log').select('id,kind,status,started_at,detail')
          .gte('started_at', cycleStart.toISOString());
        if (error) throw new Error(error.message);
        return data || [];
      }),
      20000,
      'current-cycle refresh_log summary read',
    );
    console.log(`\n${cycleRows.length} row(s) started in the current overnight cycle (since ${cycleStart.toISOString()}) — ${expectation}. Higher counts usually mean manual reruns or catch-up tests happened during the same cycle.`);
    if (vercelCrons?.length) {
      const destinationEvidenceCache = new Map();
      const dueSlots = parseScheduledUtcSlots(vercelCrons, now)
        .filter((slot) => slot.scheduledAt.getTime() <= now.getTime());
      const slotChecks = dueSlots
        .map(async (slot) => {
          const needles = triggerNeedles(slot.path);
          const directMatches = cycleRows.filter((row) => needles.some((needle) => String(row.detail || '').includes(needle)));
          const successfulDirectMatches = directMatches.filter((row) => String(row.status || '').toLowerCase() === 'ok');
          let satisfiedBy = successfulDirectMatches.length ? 'direct' : null;
          let destinationEvidenceAt = null;
          if (!satisfiedBy) {
            if (!destinationEvidenceCache.has(slot.path)) {
              destinationEvidenceCache.set(
                slot.path,
                retryOnStatementTimeout(() => readDestinationEvidenceAt(slot.path), 5, 2500).catch(() => null),
              );
            }
            destinationEvidenceAt = await destinationEvidenceCache.get(slot.path);
            const evidenceMs = destinationEvidenceAt ? new Date(destinationEvidenceAt).getTime() : 0;
            if (evidenceMs && evidenceMs >= slot.scheduledAt.getTime()) {
              satisfiedBy = 'destination';
            }
          }
          if (satisfiedBy) {
            return { slot, directMatches, successfulDirectMatches, destinationEvidenceAt, satisfiedBy, nearbyUnlabelled: [] };
          }
          const nearbyUnlabelled = cycleRows.filter((row) => {
            const detail = String(row.detail || '');
            if (detail.includes('trigger=')) return false;
            return Math.abs(new Date(row.started_at).getTime() - slot.scheduledAt.getTime()) <= NEARBY_UNLABELLED_WINDOW_MS;
          });
          return { slot, directMatches, successfulDirectMatches, destinationEvidenceAt, satisfiedBy: null, nearbyUnlabelled };
        });
      const resolvedSlotChecks = (await Promise.all(slotChecks)).filter(Boolean);
      const evidenceOnlySlots = resolvedSlotChecks.filter(({ satisfiedBy }) => satisfiedBy === 'destination');
      const resolvedMissingSlots = resolvedSlotChecks.filter(({ satisfiedBy }) => !satisfiedBy);
      if (!resolvedMissingSlots.length) {
        console.log('Every scheduled cron slot due so far has either a matching trigger-labelled refresh_log row or fresh downstream destination evidence.');
        if (evidenceOnlySlots.length) {
          console.log('Slots satisfied by downstream evidence only (no labelled refresh_log row yet in this read):');
          for (const { slot, destinationEvidenceAt } of evidenceOnlySlots) {
            const scheduledIso = slot.scheduledAt.toISOString().slice(11, 16);
            console.log(`  - ${slot.path} at ${scheduledIso} UTC (${slot.schedule}) -> destination evidence at ${destinationEvidenceAt}`);
          }
        }
      } else {
        console.log(`Missing ${resolvedMissingSlots.length} scheduled cron slot(s) due so far:`);
        for (const { slot, directMatches, nearbyUnlabelled } of resolvedMissingSlots) {
          const scheduledIso = slot.scheduledAt.toISOString().slice(11, 16);
          console.log(`  - ${slot.path} at ${scheduledIso} UTC (${slot.schedule})`);
          if (directMatches.length) {
            for (const row of directMatches.slice(0, 3)) {
              console.log(`      labelled row without ok status: id=${row.id} kind=${row.kind} status=${row.status} started_at=${row.started_at}`);
            }
          }
          if (nearbyUnlabelled.length) {
            for (const row of nearbyUnlabelled.slice(0, 3)) {
              console.log(`      nearby unlabeled row: id=${row.id} kind=${row.kind} status=${row.status} started_at=${row.started_at}`);
            }
          }
        }
      }
    }
  } catch (error) {
    console.log(`\nunable to read current-cycle refresh_log summary: ${error.message} — ${expectation}.`);
  }
  process.exit(0);
} catch (error) {
  console.log('refresh_log verification failed after retries:', error.message);
  process.exit(1);
}
