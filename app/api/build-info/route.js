import { NextResponse } from 'next/server';
import { getAppBuildInfo } from '../../../lib/buildInfo.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(
    getAppBuildInfo(),
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
