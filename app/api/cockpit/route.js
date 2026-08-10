// Clean JSON read for Cockpit Charting (District Manager page). Mirrors app/api/snapshot/route.js's
// pattern — reads already-stored data, no live SiteLink calls (those only happen in
// lib/pullCockpit.js via `npm run pull:cockpit` or GET /api/pull-cockpit).
import { NextResponse } from 'next/server';
import { readCockpitData } from '../../../lib/cockpitData.js';
import { reportingCurrentMonthStart } from '../../../lib/reportingPeriod.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Production hardening (27 Jul 2026): Cockpit reads can scan daily_financial_snapshot plus three
// months of raw_report. Give ordinary end-user reads the same explicit budget as the other stored-data
// APIs so a slow but healthy read does not collapse the District Manager page into mock data.
export const maxDuration = 300;

const AUTHENTICATED_NO_STORE = 'private, no-store';

function parseMonthStart(monthKey) {
  if (!/^\d{4}-\d{2}$/.test(String(monthKey || ''))) return null;
  const [y, m] = String(monthKey).split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) return null;
  return new Date(y, m - 1, 1);
}

function normalizeCockpitSite(site) {
  if (!site || typeof site !== 'object' || !site.code) return null;
  return {
    code: String(site.code),
    total_charge: Number(site.total_charge) || 0,
    total_payment: Number(site.total_payment) || 0,
    total_credit: Number(site.total_credit) || 0,
    categories: Array.isArray(site.categories) ? site.categories : [],
  };
}

function normalizeCockpitCurve(curve) {
  if (!Array.isArray(curve)) return [];
  return curve.map((row) => {
    if (!row || typeof row !== 'object' || !row.date) return null;
    const sites = Array.isArray(row.sites) ? row.sites.map(normalizeCockpitSite).filter(Boolean) : [];
    return {
      date: String(row.date),
      total_charge: Number(row.total_charge) || 0,
      total_payment: Number(row.total_payment) || 0,
      total_credit: Number(row.total_credit) || 0,
      sites,
    };
  }).filter(Boolean);
}

export async function GET(req) {
  try {
    const month = req.nextUrl.searchParams.get('month');
    if (month) {
      const parsed = parseMonthStart(month);
      const reportingMonth = reportingCurrentMonthStart();
      const latestMonth = `${reportingMonth.getFullYear()}-${String(reportingMonth.getMonth() + 1).padStart(2, '0')}`;
      if (!parsed) {
        return NextResponse.json({ configured: false, complete: false, error: 'Invalid month format, expected YYYY-MM' }, { status: 400, headers: { 'Cache-Control': AUTHENTICATED_NO_STORE } });
      }
      if (month > latestMonth) {
        return NextResponse.json({ configured: false, complete: false, error: `Future months are not available yet; latest reportable month is ${latestMonth}` }, { status: 400, headers: { 'Cache-Control': AUTHENTICATED_NO_STORE } });
      }
    }
    const data = await readCockpitData(month);
    const curve = normalizeCockpitCurve(data?.curve);
    const configured = curve.length > 0;
    if (!configured) {
      return NextResponse.json(
        {
          configured: false,
          complete: data?.complete !== false,
          month: data?.month || month || null,
          curve: [],
          avgDailyRate: data?.avgDailyRate == null ? null : Number(data.avgDailyRate),
          generated_at: data?.generated_at || null,
          closedMonthsUsed: Number(data?.closedMonthsUsed) || 0,
        },
        { headers: { 'Cache-Control': AUTHENTICATED_NO_STORE } },
      );
    }
    return NextResponse.json({
      configured: true,
      complete: data?.complete !== false,
      month: data?.month || month || null,
      curve,
      avgDailyRate: data?.avgDailyRate == null ? null : Number(data.avgDailyRate),
      generated_at: data?.generated_at || null,
      closedMonthsUsed: Number(data?.closedMonthsUsed) || 0,
    }, { headers: { 'Cache-Control': AUTHENTICATED_NO_STORE } });
  } catch (error) {
    return NextResponse.json({ configured: false, complete: false, error: error.message }, { status: 500, headers: { 'Cache-Control': AUTHENTICATED_NO_STORE } });
  }
}
