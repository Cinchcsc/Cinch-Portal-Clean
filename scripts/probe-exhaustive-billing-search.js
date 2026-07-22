// EXHAUSTIVE PROBE (22 Jul 2026), task #308. Michael: "look thru 100% of site link, every column
// every report to find the billing period." The previous probe hand-picked 7 likely candidates and
// came up empty. This instead attempts EVERY safe-to-call READ method across BOTH WSDLs and scans
// every single column of every response for anything billing-frequency-shaped.
//
// SAFETY (read before extending the method lists below): this project must never call a WRITE/
// mutation method against a real, live, production SiteLink account -- moving a real tenant in/out,
// charging or refunding a real payment, changing a real rate, sending a real email, running an
// arbitrary stored procedure, etc. would be a real, irreversible business action, not a data read.
//   - ReportingWs (63 methods): this whole service is "the reporting API" and every method on it has
//     already been treated as read-only throughout this project. Calling all of them is safe, MINUS
//     three excluded explicitly below: DEStartJob (starts an async job -- an action, not a read),
//     DataMineSP (SP = stored procedure -- same risk class as CallStoredProcedure below), and
//     InsurancePolicyNumUpdate (mutates despite living on the "reporting" service -- name says so).
//   - CallCenterWs (292 methods): this is the OPERATIONAL api -- moves, payments, reservations,
//     tenant management -- overwhelmingly write/action endpoints. NOT attempted wholesale. Instead
//     an explicit ALLOWLIST below of only methods whose name is UNAMBIGUOUSLY a retrieve/list/lookup
//     with no action verb anywhere in it (Add/Update/Delete/New/Insert/Remove/Cancel/Apply/Refund/
//     Reset/Disable/Login/Send/Push/Schedule/Sign/Charge*To/Payment(Simple|Multiple)/MoveIn(!Cost)/
//     MoveOut/ReservationNew/ReservationUpdate/CallStoredProcedure/LeadGeneration/etc). Any name that
//     was ambiguous either way was left OFF this list -- it can only be too conservative, never too
//     permissive. CallStoredProcedure(_v2/_v3/_v4) in particular could run arbitrary SQL against
//     their database and must never be called from any script, full stop.
//
// Special interest: the MoveInCostRetrieve* family includes literal "_28DayBilling" variants (e.g.
// MoveInCostRetrieveWithDiscount_28DayBilling) -- these are hypothetical-quote CALCULATORS (compute
// what a move-in would cost, never actually move anyone in), but the name proves SiteLink's data
// model has a real "28-day billing" concept somewhere -- these are checked first.
//
// Run:  node --env-file=.env scripts/probe-exhaustive-billing-search.js [siteCode]
import { callReport, callCallCenterMethod, describe, describeCcws, listMethods, listCcwsMethods } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-exhaustive-billing-search.js <siteCode>'); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? '').trim());
const billRe = /bill|freq|cycle|28.?day|four.?week|4.?week|weekly|anniv/i;
const matches = []; // { source, method, flagged, sample }

function scan(source, method, rows) {
  if (!rows || !rows.length) return { n: 0, flagged: [] };
  const cols = Object.keys(rows[0]);
  const flagged = cols.filter((k) => billRe.test(k));
  if (flagged.length) matches.push({ source, method, flagged, sample: rows[0] });
  return { n: rows.length, flagged };
}

console.log(`Site: ${site}   Month: ${start.toISOString().slice(0, 7)}\n`);

// Reference IDs to fill in method params that need them -- describe() decides the KEY name/type,
// this just decides the VALUE (same lesson as the last two probes' param-name bugs).
const { rows: rrRows } = await callReport('RentRoll', site, start, now);
const occRow = rrRows.find((r) => yes(r.bRented)) || rrRows[0] || {};
const known = { tenantId: occRow.TenantID, ledgerId: occRow.LedgerID, unitId: occRow.UnitID, unitName: occRow.sUnitName };
console.log('Reference IDs for param-filling:', JSON.stringify(known));
scan('RentRoll', 'RentRoll', rrRows); // already checked twice before, re-scanned here for completeness

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

// === ReportingWs: every method except the three excluded above ===
const RWS_EXCLUDE = new Set(['DEStartJob', 'DataMineSP', 'InsurancePolicyNumUpdate']);
const rwsAll = (await listMethods()).filter((m) => !RWS_EXCLUDE.has(m)).sort();
console.log(`\n=== ReportingWs: attempting ${rwsAll.length} of ${(await listMethods()).length} methods (excluded: ${[...RWS_EXCLUDE].join(', ')}) ===`);
for (const method of rwsAll) {
  try {
    const { rows } = await callReport(method, site, start, now);
    const { n, flagged } = scan('ReportingWs', method, rows);
    console.log(`  ${method}: ${n} row(s)${flagged.length ? `  <<< MATCH: ${flagged.join(', ')}` : ''}`);
  } catch (e) {
    console.log(`  ${method}: error - ${e.message}`);
  }
}

// === CallCenterWs: hand-vetted allowlist only (see header comment for the full safety reasoning) ===
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
  // MoveInCostRetrieve* family -- quote CALCULATORS, never actually move anyone in. Highest-interest
  // group given the literal "_28DayBilling" naming.
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
const ccwsAllMethods = await listCcwsMethods();
const ccwsToTry = CCWS_ALLOWLIST.filter((m) => ccwsAllMethods.includes(m));
const ccwsSkippedNotFound = CCWS_ALLOWLIST.filter((m) => !ccwsAllMethods.includes(m));
console.log(`\n=== CallCenterWs: attempting ${ccwsToTry.length} allowlisted methods (${ccwsSkippedNotFound.length} on the list weren't found on this WSDL: ${ccwsSkippedNotFound.join(', ') || 'none'}) ===`);

const d = await describeCcws();
const port = Object.values(Object.values(d)[0])[0];
for (const method of ccwsToTry) {
  try {
    const args = buildArgs(port[method]?.input);
    const { rows } = await callCallCenterMethod(method, site, args);
    const { n, flagged } = scan('CallCenterWs', method, rows);
    console.log(`  ${method}: ${n} row(s)${flagged.length ? `  <<< MATCH: ${flagged.join(', ')}` : ''}`);
  } catch (e) {
    console.log(`  ${method}: error - ${e.message}`);
  }
}

// === Summary ===
console.log('\n\n=== SUMMARY ===');
if (!matches.length) {
  console.log('No column anywhere (across every method attempted above) matched /bill|freq|cycle|28day|weekly|anniv/i.');
  console.log('This was a genuinely exhaustive pass across both WSDLs -- if the field truly exists, it is either on');
  console.log('a method excluded here for safety (a write/action endpoint), or requires a param this script could');
  console.log('not guess (e.g. a specific report needs an ID this account/tenant does not expose a value for).');
} else {
  for (const m of matches) {
    console.log(`\n[${m.source}] ${m.method} -- columns: ${m.flagged.join(', ')}`);
    console.log('Sample row:', JSON.stringify(m.sample).slice(0, 900));
  }
}
process.exit(0);
