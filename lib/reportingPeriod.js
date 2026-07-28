const firstOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);

// EXPORTED 28 Jul 2026: app/portal-v2/page.js's freshness display needs to compare a stored
// timestamp's calendar date (in the business's own Europe/London time) against a month key,
// independent of the other reporting-period helpers below (which intentionally keep using plain
// server-local Date math and are unchanged here).
export function londonCalendarParts(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const read = (type) => Number(parts.find((p) => p.type === type)?.value);
  return { year: read('year'), month: read('month'), day: read('day') };
}

export function formatLocalYmd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function lastCompleteDay(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
}

export function reportingCurrentMonthStart(now = new Date()) {
  return firstOfMonth(lastCompleteDay(now));
}

export function reportingPreviousMonthStart(now = new Date()) {
  const cur = reportingCurrentMonthStart(now);
  return new Date(cur.getFullYear(), cur.getMonth() - 1, 1);
}
