#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callReport } from '../lib/sitelink.js';
import { REPORTS } from '../lib/reportMap.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadEnvFile() {
  const candidates = [path.join(__dirname, '..', '.env'), path.join(__dirname, '..', '.env.example')];
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
      if (!process.env[key]) process.env[key] = value;
    }
  }
}

loadEnvFile();

function printHelp() {
  console.log(`Usage: node --env-file=.env scripts/debug-real-rate.js --loc L001 --month 2026-05 [--limit 50]\n\n` +
    `Pulls OccupancyStatistics + FinancialSummary for one SiteLink location and prints the raw rows\nplus the same real-rate calculation used by the portal payload builder.`);
}

function parseArgs(argv) {
  const out = { loc: undefined, month: undefined, limit: 50 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { out.help = true; return out; }
    if (arg === '--loc') { out.loc = argv[++i]; }
    else if (arg === '--month') { out.month = argv[++i]; }
    else if (arg === '--limit') { out.limit = Number(argv[++i] || 50); }
    else if (arg.startsWith('--loc=')) { out.loc = arg.split('=')[1]; }
    else if (arg.startsWith('--month=')) { out.month = arg.split('=')[1]; }
    else if (arg.startsWith('--limit=')) { out.limit = Number(arg.split('=')[1]); }
  }
  return out;
}

function monthBounds(month) {
  const [year, monthNo] = String(month).split('-').map(Number);
  if (!year || !monthNo) throw new Error('Month must be YYYY-MM');
  const start = new Date(year, monthNo - 1, 1);
  const end = new Date(year, monthNo, 0);
  return { start, end };
}

function fmtMonth(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function pickLoc(cliLoc) {
  if (cliLoc) return cliLoc;
  const envLocs = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
  return envLocs[0];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const loc = pickLoc(args.loc);
  if (!loc) {
    throw new Error('No location supplied. Pass --loc L001 or set SITELINK_LOCATIONS.');
  }

  const month = args.month || fmtMonth(new Date());
  const { start, end } = monthBounds(month);

  console.log(`Fetching OccupancyStatistics + FinancialSummary for ${loc} (${month})...`);
  const [occResp, finResp] = await Promise.all([
    callReport('OccupancyStatistics', loc, start, end),
    callReport('FinancialSummary', loc, start, end),
  ]);

  const occupancy = REPORTS.occupancy.parse(occResp.rows);
  const financial = REPORTS.financial.parse(finResp.rows);

  const totalArea = occupancy.mla_area || occupancy.total_area || 0;
  const rentRow = (financial.categories || []).find((z) => /^rent$/i.test(z.category || '') || /^rent$/i.test(z.desc || ''));
  const rentRcpt = rentRow ? (rentRow.payment || 0) : 0;
  const rcptBased = rentRcpt > 0 && totalArea > 0;
  const billedReal = occupancy.real_rate_per_sqft_ann || occupancy.rate_per_sqft_ann || 0;
  const ssBilledReal = occupancy.self_storage_real_rate_ann || 0;
  const realRate = rcptBased ? +(rentRcpt / totalArea * 12).toFixed(2) : billedReal;
  const ssReal = rcptBased ? +(realRate * (billedReal ? ssBilledReal / billedReal : 1)).toFixed(2) : (ssBilledReal || billedReal);

  const payload = {
    params: { loc, month, limit: args.limit || 50 },
    raw: {
      occupancyRows: occResp.rows.slice(0, args.limit),
      financialRows: finResp.rows.slice(0, args.limit),
      occupancyRowCount: occResp.rows.length,
      financialRowCount: finResp.rows.length,
    },
    parsed: {
      occupancy,
      financial,
    },
    calculation: {
      totalArea,
      rentRow,
      rentRcpt,
      rcptBased,
      billedReal,
      ssBilledReal,
      realRate,
      ssReal,
      formula: {
        totalRealRate: 'rentRcpt / totalArea * 12',
        ssReal: 'realRate * (ssBilledReal / billedReal)',
      },
    },
  };

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
