// Clean JSON read for the Weekly/Daily Snapshot page. Mirrors app/api/portfolio/route.js's pattern —
// reads the persisted snapshot_payload row, no live SiteLink calls (those only happen in
// lib/pullSnapshot.js via `npm run pull:snapshot` or GET /api/pull-snapshot).
import { NextResponse } from 'next/server';
import { readSnapshotPayload } from '../../../lib/snapshotPayload.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const result = await readSnapshotPayload();
    if (!result?.payload) {
      return NextResponse.json(
        { configured: false, generated_at: null, daily: null, weekly: null, quarterly: null },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
    return NextResponse.json({ configured: true, ...result.payload }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ configured: false, error: error.message }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
