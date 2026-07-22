// EXHAUSTIVE PROBE v2 (22 Jul 2026), task #308. R6 confirms billing frequency is a real field they
// sync from SiteLink, but won't be reachable until tomorrow to say exactly how. Rather than wait idle,
// this fixes a real bug just found in probe-exhaustive-billing-search.js (v1): its scan() function
// checked Object.keys(rows[0]) only -- ONE row's columns -- for every method on both WSDLs. That's
// the exact gap that mattered on RentRoll: row 1 of that report is missing CreditCardID,
// dcPushRateAtMoveIn, and dcChargeBalance, which DO exist on rows 2/3. SOAP/ADO.NET diffgrams can omit
// a field per-row instead of padding every row with the same fixed key set, so a sparse billing-
// frequency column could exist on any of these ~140 methods and still have been invisible to v1's
// row[0]-only check while v1 truthfully reported "no match."
//
// What's different here:
//  1. scan() now unions keys across EVERY row returned, not just the first, before checking names.
//  2. The name pattern is widened: added sched/interval/recur/period/cadence/plan/term to the original
//     bill/freq/cycle/28day/weekly/anniv list, in case the real column uses different wording.
//  3. Independent of naming: every column is also checked for LOW CARDINALITY (<=5 distinct values
//     across all rows of that call) even if its name matches nothing -- a billing-frequency flag would
//     take a small, repeating set of values (Monthly/28-Day/Weekly, or 0/1/2), which stands out
//     structurally regardless of what it's called. This is the same technique that worked on RentRoll,
//     generalized to every method in the sweep.
//  4. Prints the full, completely unfiltered method name list for both WSDLs once more, so they can be
//     manually re-read start to finish for anything catalog/report-list-shaped (SiteLink supports
//     account-specific CUSTOM reports beyond the ~60 standard ones -- if there's a method that lists
//     which custom report IDs exist for this corp, one of them could be exactly what R6's warehouse
//     reads, and we only know about the one we already use, ReportID 781861/"True Revenue").
//
// SAFETY -- unchanged from v1, still binding: never call a write/mutation method against the live
// production account. ReportingWs is all-safe minus DEStartJob/DataMineSP/InsurancePolicyNumUpdate.
// CallCenterWs is the same hand-vetted read-only allowlist as v1 -- no new methods added to it here,
// only the scan/detection logic changed. DataMineSP and CallStoredProcedure* remain absolute-never:
// they can run arbitrary server-side logic against a real account and there is no safe way to probe
// them "just to look."
//
// Run:  node --env-file=.env scripts/probe-exhaustive-billing-search-v2.js [siteCode]
import { callReport, callCallCenterMethod, describeCcws, listMethods, listCcwsMethods } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-exhaustive-billing-search-v2.js <siteCode>'); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? '').trim());
const billRe = /bill|freq|cycle|28.?day|four.?week|4.?week|weekly|anniv|sched|interval|recur|period|cadence|plan|term/i;
const nameMatches = []; // name-based hits
const cardMatches = []; // low-cardinality, name didn't match

function scan(source, method, rows) {
  if (!rows || !rows.length) return { n: 0, flagged: [] };
  // Union of keys across EVERY row, not just rows[0] -- the actual fix.
  const allKeys = new Set();
  for (const r of rows) for (const k of Object.keys(r)) allKeys.add(k);
  const cols = [...allKeys];

  const flagged = cols.filter((k) => billRe.test(k));
  if (flagged.length) nameMatches.push({ source, method, flagged, sample: rows.find((r) => flagged.some((k) => r[k] !== undefined)) || rows[0] });

  // Low-cardinality pass, independent of name, only for columns NOT already name-flagged.
  const unflagged = cols.filter((k) => !flagged.includes(k));
  const lowCard = [];
  for (const k of unflagged) {
    const vals = new Set(rows.map((r) => String(r[k] ?? '(blank)')));
    if (vals.size >= 2 && vals.size <= 5 && rows.length >= 8) {
      lowCard.push({ col: k, distinct: [...vals] });
    }
  }
  if (lowCard.length) cardMatches.push({ source, method, lowCard });

  return { n: rows.length, flagged };
}

console.log(`Site: ${site}   Month: ${start.toISOString().slice(0, 7)}\n`);

const { rows: rrRows } = await callReport('RentRoll', site, start, now);
const occRow = rrRows.find((r) => yes(r.bRented)) || rrRows[0] || {};
const known = { tenantId: occRow.TenantID, ledgerId: occRow.LedgerID, unitId: occRow.UnitID, unitName: occRow.sUnitName };
console.log('Reference IDs for param-filling:', JSON.stringify(known));
scan('RentRoll', 'RentRoll', rrRows);

function buildArgs(inputSchema) {
  const args = {};
  for (const key of Object.keys(inputSchema || {})) {
    const lower = key.toLowerCase();
    if (['scorpcode', 'scorpusername', 'scorppassword', 'slocationcode'].includes(lower)) continue;
    const wantsInt = /^i/.test(key);
    if (lower.includes('tenantid') && known.tenantId != null) args[key] = wantsInt ? Number(known.tenantId) : String(known.tenantId);
    else if (lower.includes('ledgerid') && known.ledgerId != null) args[key] = wantsInt ? Number(known.ledgerId) : String(known.ledgerId);
    else if (lower.includes('unitid') && known.unitId != null) args[key] = wantsInt ? Number(known.unitId) : String(known.unitId);
    else if (lower.includes('unitname') && known.unitName) args[key] = String(known.unitName);
    else if (lower === 'iglobalwaitingnum') args[key] = 0;
  }
  return args;
}

// === Full, unfiltered method name lists for manual re-read (custom-report-catalog hunt) ===
const rwsNames = await listMethods();
console.log(`\n=== ALL ${rwsNames.length} ReportingWs method names, unfiltered ===`);
rwsNames.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));

const ccwsNames = await listCcwsMethods();
console.log(`\n=== ALL ${ccwsNames.length} CallCenterWs method names, unfiltered ===`);
ccwsNames.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));

const catalogLike = [...rwsNames, ...ccwsNames].filter((m) => /report.*(list|catalog|names|available|ids)|list.*report/i.test(m));
console.log(`\nMethods that look like a report catalog/list (manual candidates to try next if any): ${catalogLike.join(', ') || 'none found by name'}`);

// === ReportingWs: every method except the three excluded for safety ===
const RWS_EXCLUDE = new Set(['DEStartJob', 'DataMineSP', 'InsurancePolicyNumUpdate']);
const rwsAll = rwsNames.filter((m) => !RWS_EXCLUDE.has(m)).sort();
console.log(`\n=== ReportingWs: attempting ${rwsAll.length} of ${rwsNames.length} methods (excluded: ${[...RWS_EXCLUDE].join(', ')}) ===`);
for (const method of rwsAll) {
  try {
    const { rows } = await callReport(method, site, start, now);
    const { n, flagged } = scan('ReportingWs', method, rows);
    console.log(`  ${method}: ${n} row(s)${flagged.length ? `  <<< NAME MATCH: ${flagged.join(', ')}` : ''}`);
  } catch (e) {
    console.log(`  ${method}: error - ${e.message}`);
  }
}

// === CallCenterWs: same hand-vetted read-only allowlist as v1, unchanged ===
const CCWS_ALLOWLIST = [
  'ACHProcessorSiteCurrentType', 'BillingInfoByTenantIDForMobile', 'BillingInfoByTenantIDForMobile_v2',
  'CCProcessorSiteCurrentType', 'CallTrackingCampaignsRetrieve', 'ChargeDescriptionsRetrieve',
  'ChargesAllByLedgerID', 'ChargesAndPaymentsByLedgerID', 'CompetitorTrackingList', 'ConvenienceFeeRetrieve',
  'CorpUserList', 'CustomBillingDateCharges', 'CustomerAccountsBalanceDetails',
  'CustomerAccountsBalanceDetailsWithDiscount', 'CustomerAccountsBalanceDetailsWithPrepayment',
  'CustomerAccountsBalanceDetailsWithPrepayment_v2', 'CustomerAccountsBalanceDetails_v2',
  'CustomerAccountsChargesWithPrepayment', 'DeliveryFeeRetrieve', 'DiscountPlanUnitTypesList',
  'DiscountPlansRetrieve', 'DiscountPlansRetrieveIncludingDisabled', 'EmployeeList', 'FormsRetrieve',
  'FormsRetrieve_v2', 'InsuranceCoverageMinimumsRetrieve', 'InsuranceCoverageRetrieve',
  'InsuranceCoverageRetrieve_V2', 'InsuranceCoverageRetrieve_V3', 'InsuranceLedgerStatusByLedgerID',
  'InsuranceLedgerStatusByLedgerIDs', 'KeypadZonesRetrieve', 'LedgerStatementByLedgerID',
  'LedgersByTenantID', 'LedgersByTenantID_v2', 'LedgersByTenantID_v3', 'MapShapesRetrieve',
  'MarketingSourcesRetrieve',
  'MoveInCostRetrieve', 'MoveInCostRetrieveWithDiscount', 'MoveInCostRetrieveWithDiscount_28DayBilling',
  'MoveInCostRetrieveWithDiscount_28DayBilling_Reservation', 'MoveInCostRetrieveWithDiscount_28DayBilling_Reservation_v2',
  'MoveInCostRetrieveWithDiscount_28DayBilling_Reservation_v3', 'MoveInCostRetrieveWithDiscount_28DayBilling_Reservation_v4',
  'MoveInCostRetrieveWithDiscount_28DayBilling_v2', 'MoveInCostRetrieveWithDiscount_28DayBilling_v3',
  'MoveInCostRetrieveWithDiscount_Reservation', 'MoveInCostRetrieveWithDiscount_Reservation_v2',
  'MoveInCostRetrieveWithDiscount_Reservation_v3', 'MoveInCostRetrieveWithDiscount_Reservation_v4',
  'MoveInCostRetrieveWithDiscount_v2', 'MoveInCostRetrieveWithDiscount_v3', 'MoveInCostRetrieveWithDiscount_v4',
  'MoveInCostRetrieveWithPushRate', 'MoveInCostRetrieveWithPushRate_v2', 'MoveInCostRetrieve_28DayBilling',
  'MoveInOutList', 'NationalMasterAccountsRetrieve', 'POSItemsRetrieve', 'PaidThroughDateByLedgerID',
  'PaymentSettings', 'PaymentTypesRetrieve', 'PaymentsByLedgerID', 'PostalCodeOwnerMarketsList',
  'PromotionsRetrieve', 'ProrationInformationRetrieve', 'PurchaseOrderNumberRetrieve', 'RentTaxRatesRetrieve',
  'ReservationBillingInfoByTenantID', 'ReservationBillingInfoByTenantID_v2', 'ReservationFeeRetrieve',
  'ReservationNotesRetrieve', 'SiteInformation', 'SiteSearchByPostalCode', 'SurchargingConfigurationRetrieve',
  'TenantBillingInfoByQRIDGlobalNumMasked', 'TenantConnectSettingsRetrieve', 'TenantIDByUnitNameOrAccessCode',
  'TenantImagePathRetrieve', 'TenantInfoByTenantID', 'TenantInvoicesByTenantID', 'TenantList',
  'TenantListDetailedMovedInTenantsOnly', 'TenantNotesRetrieve', 'TenantSearchDetailed',
  'TenantSettingsRetrieve', 'TimeZonesRetrieve', 'UnitContentsRetrieve', 'UnitTypePriceList', 'UnitTypePriceList_v2',
];
const ccwsToTry = CCWS_ALLOWLIST.filter((m) => ccwsNames.includes(m));
const ccwsSkippedNotFound = CCWS_ALLOWLIST.filter((m) => !ccwsNames.includes(m));
console.log(`\n=== CallCenterWs: attempting ${ccwsToTry.length} allowlisted methods (${ccwsSkippedNotFound.length} not found on this WSDL: ${ccwsSkippedNotFound.join(', ') || 'none'}) ===`);

const d = await describeCcws();
const port = Object.values(Object.values(d)[0])[0];
for (const method of ccwsToTry) {
  try {
    const args = buildArgs(port[method]?.input);
    const { rows } = await callCallCenterMethod(method, site, args);
    const { n, flagged } = scan('CallCenterWs', method, rows);
    console.log(`  ${method}: ${n} row(s)${flagged.length ? `  <<< NAME MATCH: ${flagged.join(', ')}` : ''}`);
  } catch (e) {
    console.log(`  ${method}: error - ${e.message}`);
  }
}

// === Summary ===
console.log('\n\n=== NAME-MATCH SUMMARY ===');
if (!nameMatches.length) {
  console.log('No column anywhere matched the widened name pattern.');
} else {
  for (const m of nameMatches) {
    console.log(`\n[${m.source}] ${m.method} -- columns: ${m.flagged.join(', ')}`);
    console.log('Sample row:', JSON.stringify(m.sample).slice(0, 900));
  }
}

console.log('\n\n=== LOW-CARDINALITY SUMMARY (unnamed candidates -- name did not match, but the column only takes a few repeating values) ===');
if (!cardMatches.length) {
  console.log('No unflagged low-cardinality columns found on any method with >=8 rows.');
} else {
  for (const m of cardMatches) {
    console.log(`\n[${m.source}] ${m.method}:`);
    for (const c of m.lowCard) console.log(`  ${c.col}: [${c.distinct.join(', ')}]`);
  }
}
process.exit(0);
