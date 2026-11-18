import { setTimeout as delay } from "node:timers/promises";
import { localDate, shiftDate } from "./dates.js";
import { PreferenceInputError } from "./preferences.js";
import { ReminderInputError, reminderTimestamp } from "./reminders.js";
import { weatherGuidance } from "./weather.js";

const HOUR = 3_600_000;
export const weatherCheckWindow = HOUR;

export function nextWeatherCheck(now, timeZone, checkTime, lastCheck) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(checkTime)) {
    throw new PreferenceInputError("请使用 24 小时制的 HH:mm，例如 08:00。");
  }
  let date = localDate(timeZone, now);
  const lastDate = lastCheck == null ? null : localDate(timeZone, lastCheck);
  // A DST transition may skip or duplicate the requested time. In that
  // case use the next day with an unambiguous clock time.
  for (let day = 0; day < 4; day++, date = shiftDate(date, 1)) {
    if (lastDate && date <= lastDate) continue;
    try {
      const instant = reminderTimestamp(date + "T" + checkTime, timeZone, -Infinity);
      if (instant > now && (lastCheck == null || instant - lastCheck >= 20 * HOUR)) return instant;
    } catch (error) {
      if (!(error instanceof ReminderInputError)) throw error;
    }
  }
  throw new PreferenceInputError("无法确定下一次天气检查时间，请核对时区和时间。");
}

function matchesCity(requested, weather) {
  if (typeof weather.city !== "string" || !weather.city.trim()) return false;
  const normalize = (value) => value.trim().toLowerCase();
  const district = typeof weather.district === "string" ? weather.district : "";
  const province = typeof weather.province === "string" ? weather.province : "";
  const city = weather.city.trim();
  const cities = [city];
  if (/\p{Script=Han}/u.test(city)) cities.push(city.endsWith("市") ? city.slice(0, -1) : city + "市");
  const names = [district];
  for (const name of cities) names.push(name, name + district, province + name, province + name + district);
  return names.some((name) => name.length && normalize(name) === normalize(requested));
}

function reportTimestamp(value, timeZone) {
  if (typeof value !== "string") return NaN;
  if (/(?:Z|[+-]\d\d:?\d\d)$/u.test(value)) return Date.parse(value);
  try {
    return reminderTimestamp(value, timeZone, -Infinity);
  } catch (error) {
    if (!(error instanceof ReminderInputError)) throw error;
    return NaN;
  }
}

function assessWeather(subscription, data, now) {
  const weather = data?.weather;
  if (!data?.success || !weather || !matchesCity(subscription.city, weather)) {
    return { status: "location_mismatch" };
  }
  const reportedAt = reportTimestamp(weather.report_time, subscription.timezone);
  if (!Number.isFinite(reportedAt) || now - reportedAt > 6 * HOUR || reportedAt - now > 10 * 60_000) {
    return { status: "stale_report" };
  }
  const date = localDate(subscription.timezone, now);
  const { current, forecast } = weatherGuidance(weather);
  const tips = [...current, ...(forecast.find((day) => day.date === date)?.tips ?? [])];
  if (!tips.length) return { status: "no_match" };
  return { status: "queued",
    content: `${weather.city}天气提醒（${date}）\n${tips.join("\n")}\n来源 UAPI，更新时间 ${weather.report_time}。` };
}

export async function checkDueWeather({ store, weather, signal, now = Date.now }) {
  signal?.throwIfAborted();
  const started = now();
  const subscription = store.claimWeatherCheck(started);
  if (!subscription) return;
  let result = { status: "missed" };
  if (subscription.inWindow) {
    try {
      const data = await weather.getWeather({ city: subscription.city }, { signal });
      signal?.throwIfAborted();
      const finished = now();
      if (finished - subscription.scheduled < weatherCheckWindow
          && localDate(subscription.timezone, started) === localDate(subscription.timezone, finished)) {
        result = assessWeather(subscription, data, finished);
      }
    } catch {
      signal?.throwIfAborted();
      result = { status: "lookup_failed" };
    }
  }
  const applied = store.finishWeatherCheck(subscription, result, now());
  console.log(`[weather] subscription_check=${applied ? result.status : "superseded"}`);
}

export async function runWeatherScheduler({ store, weather, isReady, signal }) {
  while (!signal.aborted) {
    try {
      if (isReady()) await checkDueWeather({ store, weather, signal });
    } catch (error) {
      if (!signal.aborted) console.error("[weather] subscription check failed", { name: error?.name, code: error?.code });
    }
    try { await delay(15_000, undefined, { signal }); }
    catch (error) { if (!signal.aborted) throw error; }
  }
}
