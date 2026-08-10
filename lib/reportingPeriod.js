const LONDON_TZ = 'Europe/London';
const firstOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);

export function londonCalendarParts(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: LONDON_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const read = (type) => Number(parts.find((p) => p.type === type)?.value);
  return { year: read('year'), month: read('month'), day: read('day') };
}

export function formatLocalYmd(d) {
  const { year, month, day } = londonCalendarParts(d);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function lastCompleteDay(now = new Date()) {
  const { year, month, day } = londonCalendarParts(now);
  return new Date(year, month - 1, day - 1);
}

export function startOfReportingToday(now = new Date()) {
  const { year, month, day } = londonCalendarParts(now);
  return new Date(year, month - 1, day);
}

export function reportingCurrentMonthStart(now = new Date()) {
  return firstOfMonth(lastCompleteDay(now));
}

export function reportingPreviousMonthStart(now = new Date()) {
  const cur = reportingCurrentMonthStart(now);
  return new Date(cur.getFullYear(), cur.getMonth() - 1, 1);
}
