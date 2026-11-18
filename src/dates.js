export function localDate(timeZone, instant = Date.now()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(instant).padStart(10, "0");
}

export function isCalendarDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}

export function shiftDate(date, days) {
  const utc = new Date(date + "T00:00:00Z");
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

export function dateRange({ period = "this_month", start_date, end_date } = {}, timeZone, now) {
  for (const date of [start_date, end_date]) {
    if (date == null || date === "") continue;
    if (!isCalendarDate(date)) throw new RangeError("请提供有效的 YYYY-MM-DD 日期。");
  }
  if (start_date && end_date && start_date > end_date) throw new RangeError("开始日期不能晚于结束日期。");
  if (start_date || end_date) return { label: "custom", start: start_date || "0000-01-01", end: end_date || "9999-12-31" };
  if (period === "all") return { label: period, start: "0000-01-01", end: "9999-12-31" };
  const today = localDate(timeZone, now);
  if (period === "today") return { label: period, start: today, end: today };
  if (period === "last_7_days") return { label: period, start: shiftDate(today, -6), end: today };
  if (period === "this_week" || period === "last_week") {
    const weekday = new Date(today + "T00:00:00Z").getUTCDay() || 7;
    const start = shiftDate(today, 1 - weekday - (period === "last_week" ? 7 : 0));
    return { label: period, start, end: shiftDate(start, 6) };
  }
  const first = today.slice(0, 8) + "01";
  if (period === "last_month") {
    const end = shiftDate(first, -1);
    return { label: period, start: end.slice(0, 8) + "01", end };
  }
  const nextMonth = shiftDate(first, 32).slice(0, 8) + "01";
  return { label: "this_month", start: first, end: shiftDate(nextMonth, -1) };
}

// Notes have UTC timestamps. Find the first instant of a civil date even
// when the timezone skips or repeats local midnight.
export function noteTimeBounds({ start, end }, timeZone) {
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  });
  function startOfDay(date) {
    const midnight = Date.parse(date + "T00:00:00Z");
    let low = midnight - 86_400_000;
    let high = midnight + 86_400_000;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (formatter.format(mid).padStart(10, "0") < date) low = mid + 1;
      else high = mid;
    }
    return high;
  }
  const first = start === "0000-01-01" ? "" : new Date(startOfDay(start)).toISOString();
  const last = end === "9999-12-31" ? "9999-12-31T23:59:59.999Z"
    : new Date(startOfDay(shiftDate(end, 1)) - 1).toISOString();
  return [first, last];
}
