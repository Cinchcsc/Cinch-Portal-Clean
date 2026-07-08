// SiteLink Reporting API SOAP client.
// CONFIRMED from the SiteLink Reporting API doc (2017 ed.):
//   • All report methods live on ReportingWs.asmx (NOT CallCenterWs).
//   • Auth: the API License Key is appended to the corp username as  <username>:::<licenseKey>.
//   • Every report method takes 6 POSITIONAL params, in order:
//       (1) corp code (2) location code (3) username[:::key] (4) password (5) start date (6) end date
//   • Returns an ADO.NET DataSet (XML). On failure: a table "RT" with a negative Ret_Code.
// node-soap maps the args object onto the WSDL by element name; SiteLink's names are
// sCorpCode / sLocationCode / sCorpUserName / sCorpPassword / dStartDate / dEndDate.
// (Confirm exact casing once with `npm run test:connection`, which prints describe().)
import soap from 'soap';

let _client = null;
export async function client() {
  if (_client) return _client;
  if (!process.env.SITELINK_WSDL) throw new Error('SITELINK_WSDL not set');
  _client = await soap.createClientAsync(process.env.SITELINK_WSDL);
  return _client;
}

// CallCenterWs.asmx — a SEPARATE SiteLink service from ReportingWs.asmx above. It has no report
// methods (confirmed 2 Jul 2026 — that's why the regular pulls use ReportingWs instead), but it's
// the only place `ReservationList` lives, which the "Reservations vs Move-outs" KPI widget needs.
// CONFIRMED BUG (2 Jul 2026): this used to DERIVE the CallCenterWs URL from SITELINK_WSDL by
// swapping just the filename, assuming the same folder path — but SiteLink versions ReportingWs
// and CallCenterWs under DIFFERENT subfolders (e.g. ".../RWs_3.5/ReportingWs.asmx" vs
// ".../CCWs_3.5/CallCenterWs.asmx"), so the derived URL was landing in the wrong folder. Every
// ReservationList call up to now may have been hitting the wrong endpoint entirely — a real
// candidate explanation for the unexplained QTRentalStatusID data we've been chasing. Now reads an
// EXPLICIT env var (SITELINK_CCWS_WSDL) instead of guessing, falling back to the old derivation
// only if that var isn't set (so nothing breaks before the .env is updated).
let _ccwsClient = null;
export async function ccwsClient() {
  if (_ccwsClient) return _ccwsClient;
  const url = (process.env.SITELINK_CCWS_WSDL || '').trim()
    || (process.env.SITELINK_WSDL || '').replace(/ReportingWs\.asmx/i, 'CallCenterWs.asmx');
  if (!url || url === process.env.SITELINK_WSDL) throw new Error('Could not determine CallCenterWs URL — set SITELINK_CCWS_WSDL explicitly in .env.');
  _ccwsClient = await soap.createClientAsync(url);
  return _ccwsClient;
}

// ReservationList takes no date range (just iGlobalWaitingNum=0 for "all") — it returns the
// account's live waiting list, which drops a row once it's converted to a tenant (moved in), so
// "not moved in" is inherent to what this call returns at all; the parser (lib/reportMap.js) still
// filters out cancelled rows and past-due `dNeeded` dates.
export async function callReservationList(locationCode) {
  const c = await ccwsClient();
  const args = { ...creds(), sLocationCode: locationCode, iGlobalWaitingNum: 0 };
  const TIMEOUT = Number(process.env.SITELINK_CALL_TIMEOUT_MS || 60000);
  const [result] = await withTimeout(c.ReservationListAsync(args), TIMEOUT, `ReservationList/${locationCode}`);
  try { checkReturnCode(result); }
  catch (e) { if (e.retCode === -1) return { rows: [], raw: result }; throw e; }
  return { rows: extractRows(result), raw: result };
}

// Credentials shared by every call. The license key rides on the username with ':::'.
export function creds() {
  // Tolerate SITELINK_CORP_USER being entered as either just the username OR the full
  // "username:::licenseKey" (the doc shows the login that way) — take only the part before ':::'
  // and append the key ourselves, so we never double it up.
  const user = (process.env.SITELINK_CORP_USER || '').split(':::')[0];
  return {
    sCorpCode: process.env.SITELINK_CORP_CODE,
    sCorpUserName: `${user}:::${process.env.SITELINK_LICENSE_KEY}`,
    sCorpPassword: process.env.SITELINK_CORP_PASSWORD,
  };
}

// LOCAL date (not UTC) — toISOString() shifts BST dates back a day, which queried the wrong month window.
const fmtDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T00:00:00`;

// Reject a call that stalls, so one hung report can't freeze the whole pull.
function withTimeout(promise, ms, label) {
  let t; const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); });
  return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(t)), timer]);
}

// Call a report method for one location (+ optional month range). Returns { rows, raw }.
export async function callReport(method, locationCode, startDate, endDate) {
  const c = await client();
  const fn = c[method + 'Async'];
  if (typeof fn !== 'function') {
    throw new Error(`SOAP method "${method}" not on the WSDL — run describe(). Available: ` +
      Object.keys(c).filter(k => k.endsWith('Async')).slice(0, 60).join(', '));
  }
  const args = { ...creds(), sLocationCode: locationCode };
  if (startDate) args.dReportDateStart = fmtDate(startDate); // confirmed WSDL param names
  if (endDate) args.dReportDateEnd = fmtDate(endDate);
  const TIMEOUT = Number(process.env.SITELINK_CALL_TIMEOUT_MS || 60000);
  const [result] = await withTimeout(fn(args), TIMEOUT, `${method}/${locationCode}`);
  try { checkReturnCode(result); }
  catch (e) { if (e.retCode === -1) return { rows: [], raw: result }; throw e; }  // -1 = "no data" → empty, not an error/retry
  return { rows: extractRows(result), raw: result };
}

// CustomReportByReportID — pulls a SiteLink CUSTOM report (one built through SiteLink's own
// report-builder tool, tied to a numeric ReportID unique to this account) rather than a standard
// documented report method. Confirmed working 2 Jul 2026 via an earlier version of this project's
// own Python scripts (true_revenue.py / sitelink_test.py), which successfully called this method
// against ReportID 781861 ("Financial \ True Revenue Report - Daily Prorate" — what Michael calls
// "Daily Pro Rate"). NOT documented in SiteLink's official Reporting API PDF (custom reports aren't
// part of the public method list at all), so treat this as confirmed-by-observation, not spec.
export async function callCustomReport(reportId, locationCode, startDate, endDate) {
  const c = await client();
  const fn = c.CustomReportByReportIDAsync;
  if (typeof fn !== 'function') {
    throw new Error('SOAP method "CustomReportByReportID" not on the WSDL — run describe() to check availability.');
  }
  const args = { ...creds(), sLocationCode: locationCode, ReportID: reportId };
  if (startDate) args.dReportDateStart = fmtDate(startDate);
  if (endDate) args.dReportDateEnd = fmtDate(endDate);
  const TIMEOUT = Number(process.env.SITELINK_CALL_TIMEOUT_MS || 60000);
  const [result] = await withTimeout(fn(args), TIMEOUT, `CustomReportByReportID(${reportId})/${locationCode}`);
  try { checkReturnCode(result); }
  catch (e) { if (e.retCode === -1) return { rows: [], raw: result }; throw e; }
  return { rows: extractRows(result), raw: result };
}

// SiteLink signals failure with a table "RT" carrying a negative Ret_Code.
export function checkReturnCode(result) {
  // deep-find a Ret_Code anywhere (the RT error table may be a single object, not an array)
  let ret = null;
  (function find(node) {
    if (!node || typeof node !== 'object' || ret) return;
    if (node.Ret_Code != null) { ret = node; return; }
    for (const v of Object.values(node)) if (v && typeof v === 'object') find(v);
  })(result);
  if (ret && Number(ret.Ret_Code) < 0) {
    const code = Number(ret.Ret_Code);
    const known = { '-1': 'no data for the date range', '-89': 'invalid API license key',
      '-90': 'server busy — retry in 15s', '-97': 'invalid location code',
      '-98': 'invalid credentials', '-99': 'general exception' };
    const e = new Error(`SiteLink: ${ret.Ret_Msg || known[String(code)] || 'error'} (Ret_Code ${code})`);
    e.retCode = code; throw e;
  }
}

// DataSet rows sit a few levels down (…Result → diffgram → NewDataSet → Table[]); grab the
// largest array of row-objects we find.
export function extractRows(result) {
  if (!result) return [];
  // The DataSet has an inline <schema> (column DEFINITIONS) AND a <diffgram> (the real DATA).
  // Scope to the diffgram so we don't mistake the schema's element list for data rows.
  let diff = null;
  (function find(node) {
    if (!node || typeof node !== 'object' || diff) return;
    for (const [k, v] of Object.entries(node)) {
      if (diff) return;
      if (/diffgram/i.test(k) && v && typeof v === 'object') { diff = v; return; }
      if (v && typeof v === 'object') find(v);
    }
  })(result);
  const scope = diff || result;
  const seen = new Set(); let found = [];
  (function walk(node) {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    for (const v of Object.values(node)) {
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') { if (v.length > found.length) found = v; }
      else if (v && typeof v === 'object') walk(v);
    }
  })(scope);
  // node-soap puts each row's column values under `.attributes` — flatten them up.
  return found.map(r => {
    if (r && typeof r === 'object' && r.attributes && typeof r.attributes === 'object') {
      const { attributes, ...rest } = r; return { ...attributes, ...rest };
    }
    return r;
  });
}

// ADDED 7 Jul 2026 — companion to extractRows(): SiteLink's multi-table reports (confirmed for
// ManagementSummary, which returns 9 separate tables: Receipts/Concessions/Discounts/Delinquency/
// Unpaid/RentLastChanged/VarFromStdRate/UnitActivity/Alerts) were silently losing every table except
// the single largest one, because extractRows() only ever keeps `if (v.length > found.length)`.
// For ManagementSummary that meant the genuine "Delinquency"/"Unpaid" tables (SiteLink's OWN
// internal 30+-days-overdue calculation) were discarded on every pull, ever — the Debtor Levels
// widget was instead built from a home-grown DaysLate>30 filter over PastDueBalances' raw tenant
// rows, which doesn't agree with SiteLink's own number (confirmed via a live SiteLink UI export for
// Gillingham/Jul 2026: SiteLink's own Delinquency total was £973.29, not our £1,059.12). This
// function returns one NAMED table instead of "whichever is biggest", for callers that need a
// specific table a multi-table report exposes. `raw` is the `{ raw }` value callReport() already
// returns — nothing about the existing extractRows()/callReport() single-table path changes.
export function extractNamedTable(raw, tableName) {
  if (!raw) return [];
  let diff = null;
  (function find(node) {
    if (!node || typeof node !== 'object' || diff) return;
    for (const [k, v] of Object.entries(node)) {
      if (diff) return;
      if (/diffgram/i.test(k) && v && typeof v === 'object') { diff = v; return; }
      if (v && typeof v === 'object') find(v);
    }
  })(raw);
  const scope = diff || raw;
  let found = null;
  const seen = new Set();
  (function walk(node) {
    if (!node || typeof node !== 'object' || seen.has(node) || found) return;
    seen.add(node);
    for (const [k, v] of Object.entries(node)) {
      if (found) return;
      if (Array.isArray(v) && v.length && typeof v[0] === 'object' && k.toLowerCase() === tableName.toLowerCase()) { found = v; return; }
      else if (v && typeof v === 'object') walk(v);
    }
  })(scope);
  if (!found) return [];
  return found.map(r => {
    if (r && typeof r === 'object' && r.attributes && typeof r.attributes === 'object') {
      const { attributes, ...rest } = r; return { ...attributes, ...rest };
    }
    return r;
  });
}

export async function listMethods() {
  const c = await client();
  return Object.keys(c).filter(k => k.endsWith('Async')).map(k => k.replace(/Async$/, ''));
}
export async function describe() { return (await client()).describe(); }
