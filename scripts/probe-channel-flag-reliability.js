// PROBE (20 Jul 2026), READ-ONLY — direct follow-up to probe-conversion-field-check.js. That probe
// showed the ENTIRE portfolio Enquiry->Reservation gap (14.5-14.9% ours vs legacy's 19.9%) is
// concentrated in Phone (33.6% ours vs legacy ~51.1%) and Walk-in (24.7% vs ~67.8%), while Web+Email
// (88% of volume) tracks legacy closely. Both of our candidate numerators (reservation_stage_count,
// conversions/iInquiryConvertedToLease) gave similarly-low results, and site-scope + filter-width were
// already ruled out (see probe-enquiry-reservation-gap.js, probe-conversion-field-check.js).
//
// Git history (recovered from deleted-script commit messages, task #94/#301/#303/#310) established two
// things that matter here:
//   1. InquiryTracking gives a NEW ROW per funnel-stage event, not one row per lead (reportMap.js's own
//      8 Jul comment). A single person's Inquiry / Reservation / Move-In rows are 3 SEPARATE rows.
//   2. Per-lead cohort-matching (email/phone hash, task #301) and lookback windows (task #303) were
//      BOTH tried as the metric itself and abandoned — they undercounted the whole portfolio too
//      severely (low single digits – ~10%) vs legacy's 19.8%, so Michael confirmed (task #310) legacy
//      is doing a plain aggregate ratio too, not per-lead joining, and we reverted to match that.
//
// That closes off "switch to cohort-matching as the production formula" as an option, but it doesn't
// tell us WHY specifically Phone/Walk-in's `iInquiryConvertedToLease` flag reads so much lower than
// legacy's own channel figures. This probe uses email/phone cohort-matching purely as a DIAGNOSTIC
// (not a proposed replacement metric) to test one specific hypothesis: is the converted-flag on the
// original Inquiry-stage row simply unreliable for Phone/Walk-in — i.e., does it often stay false even
// when we have DIRECT, INDEPENDENT proof the same lead has a later Reservation or Move-In stage row
// elsewhere in our own stored data?
//
// Method: pool Activity rows from the last 3 months' raw_response (May/Jun/Jul 2026) per site — SiteLink
// InquiryTracking already returns a "wider working set" beyond the exact requested month (see
// reportMap.js comments), so this pooling just gives a fuller picture of each lead's own stage history.
// For every Inquiry-stage row, look up all OTHER rows sharing its email hash or phone hash. If any of
// those rows is Reservation or Move-In stage, we have independent proof this lead progressed — then
// check whether iInquiryConvertedToLease was actually true on the inquiry row (or anywhere in the
// group). Split by channel (sInquiryType).
//
// PII-SAFE: sEmail/sPhone hashed (SHA-256) immediately on read, raw values never stored/printed/logged.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-channel-flag-reliability.js
import { createHash } from 'node:crypto';
import { admin } from '../lib/supabaseAdmin.js';
import { extractNamedTable } from '../lib/sitelink.js';
import { writeFileSync } from 'fs';

const str = (v) => String(v ?? '').trim();
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? ''));
const emailHash = (v) => { const e = str(v).toLowerCase(); return e ? createHash('sha256').update(e).digest('hex') : null; };
const phoneHash = (v) => { const d = String(v ?? '').replace(/\D/g, ''); return d.length >= 10 ? createHash('sha256').update(d.slice(-10)).digest('hex') : null; };

const MONTHS = ['2026-05-01', '2026-06-01', '2026-07-01'];

const { data: rows, error } = await admin
  .from('raw_report').select('site_code,month,raw_response')
  .in('month', MONTHS).eq('report', 'lead_funnel');
if (error) { console.error('lead_funnel fetch failed:', error.message); process.exit(1); }

// Pool every Activity row across all fetched (site, month) pulls. Attach a contact key set to each.
const pool = [];
for (const rec of rows || []) {
  let raw = rec.raw_response; if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = null; } }
  if (!raw) continue;
  const activity = extractNamedTable(raw, 'Activity');
  for (const r of activity) {
    pool.push({
      site: rec.site_code,
      channel: str(r.sInquiryType) || '(none)',
      stage: str(r.sRentalType) || '(blank)',
      converted: yes(r.iInquiryConvertedToLease),
      eh: emailHash(r.sEmail),
      ph: phoneHash(r.sPhone),
    });
  }
}

// Index by contact hash for fast group lookup.
const byEmail = new Map(), byPhone = new Map();
const pushTo = (map, key, val) => { if (!map.has(key)) map.set(key, []); map.get(key).push(val); };
for (const r of pool) {
  if (r.eh) pushTo(byEmail, r.eh, r);
  if (r.ph) pushTo(byPhone, r.ph, r);
}
function groupFor(r) {
  const set = new Set();
  if (r.eh) for (const x of byEmail.get(r.eh) ?? []) set.add(x);
  if (r.ph) for (const x of byPhone.get(r.ph) ?? []) set.add(x);
  set.add(r);
  return [...set];
}

const perChannel = {};
for (const r of pool) {
  if (r.stage !== 'Inquiry') continue;   // only auditing the original enquiry-stage row
  const c = (perChannel[r.channel] ??= {
    inquiry_rows: 0,
    has_later_stage_proof: 0,          // same contact has a Reservation/Move-In row somewhere in pool
    flag_true_on_this_row: 0,          // iInquiryConvertedToLease true on THIS inquiry row
    proof_but_flag_false_everywhere: 0, // the smoking-gun bucket: proven progression, flag never set
    no_proof_but_flag_true: 0,          // flag true with no corroborating later-stage row (edge case)
  });
  c.inquiry_rows++;
  if (r.converted) c.flag_true_on_this_row++;

  const group = groupFor(r);
  const hasLaterStage = group.some((x) => x.stage === 'Reservation' || x.stage === 'Move In');
  const flagTrueAnywhere = group.some((x) => x.converted);

  if (hasLaterStage) {
    c.has_later_stage_proof++;
    if (!flagTrueAnywhere) c.proof_but_flag_false_everywhere++;
  } else if (r.converted) {
    c.no_proof_but_flag_true++;
  }
}

const summary = Object.fromEntries(Object.entries(perChannel).map(([channel, c]) => [channel, {
  ...c,
  pct_with_later_stage_proof: c.inquiry_rows ? +(c.has_later_stage_proof / c.inquiry_rows * 100).toFixed(1) : null,
  pct_of_proven_that_flag_missed: c.has_later_stage_proof ? +(c.proof_but_flag_false_everywhere / c.has_later_stage_proof * 100).toFixed(1) : null,
}]));

const out = {
  probed_at: new Date().toISOString(),
  months_pooled: MONTHS,
  total_activity_rows_pooled: pool.length,
  per_channel: summary,
  note: 'pct_of_proven_that_flag_missed is the key number: of Inquiry-stage rows we can INDEPENDENTLY prove progressed further (a Reservation/Move-In row exists for the same email or phone), what % never got iInquiryConvertedToLease set to true anywhere. If this is much higher for Phone/WalkIn than Web/EMail, the converted-flag itself is unreliable specifically for those channels.',
};

const outPath = new URL('../../channel-flag-reliability-probe.json', import.meta.url);
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${outPath.pathname}`);
console.log(`\nPooled ${pool.length} Activity rows across ${MONTHS.join('/')}.\n`);
console.log('Channel        Inquiry rows   %w/ later-stage proof   Of those, % flag missed');
for (const [channel, c] of Object.entries(summary)) {
  console.log(`${channel.padEnd(14)} ${String(c.inquiry_rows).padEnd(14)} ${String(c.pct_with_later_stage_proof + '%').padEnd(23)} ${c.pct_of_proven_that_flag_missed}%`);
}
process.exit(0);
