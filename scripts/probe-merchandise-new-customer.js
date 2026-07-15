// Task #230 (15 Jul 2026 audit finding): "Merchandise Income per New Customer" reads £9.12 (ours)
// vs £1.12 (legacy), ~8x -- same bug class flagged once before (task #125, ~11x) and apparently
// never actually fixed. Live comparison confirms our numerator (merchSalesSum, page.js) and
// denominator (moveInsSum) BOTH independently match legacy closely on their own (Merchandise Sales
// £4,421 ours vs £4,359 legacy; Move-ins 485 ours vs 471 legacy) -- so the current formula
// (ALL customers' merchandise spend this month ÷ new move-ins this month) is internally consistent
// but is answering the wrong question. It divides EVERYONE's spending by just the NEW customers'
// count, which structurally overstates "per new customer" income, since most merchandise revenue in
// a given month comes from existing long-standing tenants, not this month's move-ins.
//
// Legacy's £1.12 has no visible tooltip/formula on the live site (checked directly -- no info icon
// on this widget, unlike Autobill/Insurance Roll/Insurance Conversion which do have one), so the
// correct fix is inferred: legacy is very likely computing genuinely NEW-CUSTOMER-SCOPED merchandise
// revenue (i.e., only charges billed to tenants who moved in THIS month), not total portfolio
// merchandise revenue. Neither MerchandiseSummary nor FinancialSummary (our two current merchandise
// sources) carry a TenantID/move-in-date -- confirmed via reportMap.js's `merchandise`/`financial`
// parsers, both pure category totals with no per-tenant breakdown.
//
// However: the True Revenue custom report (781861) DOES have a genuine per-transaction table with
// tenant identity (per the 14 Jul probe-truerevenue-coverage.js findings: "Table2 -- 1853 rows... one
// row per individual charge/tenant/invoice transaction, carrying Unit, UnitType, Tenant, Company,
// dMovedIn, AccountCode, ChargeDesc, Amount..."). This script tests the hypothesis that filtering
// Table2 to ChargeDesc="Merchandise" (or similar) AND dMovedIn falling in the current month, then
// dividing by move-ins, lands much closer to legacy's £1.12 -- WITHOUT committing anything to
// reportMap.js/buildPayload.js/page.js first, since the exact field names/casing on Table2 haven't
// been directly confirmed in this session (only described secondhand in an earlier probe's summary).
// This prints the ACTUAL keys on real Merchandise-charge rows so there's no more guessing.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-merchandise-new-customer.js
import { callCustomReport, extractRows, extractNamedTable } from '../lib/sitelink.js';
import { callReport } from '../lib/sitelink.js';
import { checkPullLock } from '../lib/pullLock.js';

const lock = await checkPullLock();
if (lock.locked) { console.error('[probe-merchandise-new-customer] ' + lock.message); process.exit(1); }

const NAMES = { L001: 'Bicester', L002: 'Leighton Buzzard', L003: 'Letchworth', L004: 'Chippenham', L005: 'Brighton', L006: 'Huntingdon', L007: 'Newmarket', L008: 'Enfield', L009: 'Newbury', L010: 'Mitcham', L011: 'Sittingbourne', L012: 'Gillingham', L013: 'Brentwood', L014: 'Earlsfield', L015: 'Watford', L016: 'Seaford', L017: 'Southend', L018: 'Woking', L019: 'Sidcup', L020: 'Dunstable', L021: 'Bedford', L022: 'Swindon', L023: 'Wisbech', L024: 'Newcastle', L025: 'Shoreham-By-Sea', L026: 'Paulton', L027: 'Exeter', L028: 'Edmonton', L029: 'Abingdon' };
const EXCLUDE = new Set(['L021', 'L026', 'L027']); // Bedford, Paulton, Exeter -- match legacy comparison scope
const sites = Object.keys(NAMES).filter((c) => !EXCLUDE.has(c));

const num = (row, ...keys) => {
  for (const k of keys) {
    if (row && row[k] != null && row[k] !== '') {
      const n = Number(String(row[k]).replace(/[£,%\s]/g, ''));
      if (!Number.isNaN(n)) return n;
    }
  }
  return 0;
};
const str = (v) => (v == null ? '' : String(v)).trim();
const isBlankDate = (v) => v === undefined || v === null || v === '' || v === '0001-01-01T00:00:00';

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);

let totalMerchAllCustomers = 0, totalMerchNewCustomers = 0, totalMoveIns = 0, sampleKeysPrinted = false;

for (const loc of sites) {
  try {
    const { raw } = await callCustomReport(781861, loc, start, now);
    const table2 = extractRows(raw); // whatever extractRows() currently keeps (the largest table -- expected to be the per-transaction one)

    const merchRows = table2.filter((r) => /merchandis/i.test(str(r.ChargeDesc ?? r.sChgDesc ?? r.Description)));
    if (merchRows.length && !sampleKeysPrinted) {
      console.log('--- Sample Merchandise row keys (first match found, so field names below are no longer a guess) ---');
      console.log(JSON.stringify(merchRows[0], null, 2));
      sampleKeysPrinted = true;
    }

    const allMerchThisSite = merchRows.reduce((a, r) => a + num(r, 'Amount', 'TruePeriod', 'dcAmount'), 0);
    const newCustMerchThisSite = merchRows
      .filter((r) => {
        const mv = r.dMovedIn ?? r.DMovedIn ?? r.MovedIn ?? r.dMoveIn;
        if (isBlankDate(mv)) return false;
        const d = new Date(mv);
        return d >= start && d <= now;
      })
      .reduce((a, r) => a + num(r, 'Amount', 'TruePeriod', 'dcAmount'), 0);

    const { rows: mioRows } = await callReport('MoveInsAndMoveOuts', loc, start, now);
    const moveIns = mioRows.length; // rough count; buildPayload.js's real moveIns field is more precise but this is just for ratio-testing

    totalMerchAllCustomers += allMerchThisSite;
    totalMerchNewCustomers += newCustMerchThisSite;
    totalMoveIns += moveIns;
    process.stderr.write(`  ${loc} ${NAMES[loc]}: all-customer merch £${allMerchThisSite.toFixed(2)}, new-customer merch £${newCustMerchThisSite.toFixed(2)}, move-ins ${moveIns}\n`);
  } catch (e) {
    console.error(`  ${loc}: FAILED — ${e.message}`);
  }
}

console.log(`\nPortfolio (${sites.length} sites, Bedford/Paulton/Exeter excluded):`);
console.log(`  Move-ins: ${totalMoveIns}`);
console.log(`  CURRENT FORMULA (all-customer merch ÷ move-ins): £${(totalMerchAllCustomers / totalMoveIns).toFixed(2)}  <- this is what the portal shows today (~£9)`);
console.log(`  CANDIDATE FIX (new-customer-only merch ÷ move-ins): £${(totalMerchNewCustomers / totalMoveIns).toFixed(2)}  <- compare this to legacy's £1.12`);
console.log('\nIf the candidate fix lands close to £1.12, the field names above (ChargeDesc/dMovedIn/Amount or whatever printed) are confirmed correct and safe to wire into reportMap.js\'s true_revenue parser + buildPayload.js + page.js. If it does not, the sample row JSON above should show what fields ARE available so we can figure out the real formula.');
process.exit(0);
