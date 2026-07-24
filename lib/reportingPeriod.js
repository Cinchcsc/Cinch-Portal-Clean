const firstOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);

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
