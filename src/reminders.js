import { setTimeout as delay } from "node:timers/promises";

const SCAN_INTERVAL_MS = 5_000;
const SEND_TIMEOUT_MS = 45_000;
const RETRY_DELAY_MS = 60_000;
const LATE_WINDOW_MS = 15 * 60_000;
const STALE_SEND_MS = 2 * 60_000;

// Only these controlled validation messages may be shown to the model.
export class ReminderInputError extends Error {}

function timeFormatter(timeZone) {
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
  } catch {
    throw new ReminderInputError("时区无效，请确认时区名称，例如 Asia/Shanghai。");
  }
}

export function reminderLocalTime(timestamp, timeZone) {
  return timeFormatter(timeZone).format(timestamp);
}

// Resolve the user's wall clock time independently of the server's TZ.
export function reminderTimestamp(value, timeZone, now) {
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) throw new ReminderInputError("请提供明确的日期和时间，精确到分钟。");
  const [, date, time, seconds = "00", fraction = "", offset] = match;
  const local = `${date}T${time}:${seconds}`;
  const wall = Date.parse(local + "Z");
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 19) !== local) {
    throw new ReminderInputError("日期或时间无效，请确认后再创建。");
  }
  const formatter = timeFormatter(timeZone);
  const wallTimeAt = (instant) => formatter.format(instant).replace(" ", "T");
  const candidates = new Set();
  if (offset === "Z") {
    candidates.add(wall);
  } else if (offset) {
    const instant = Date.parse(local + offset);
    if (Number.isFinite(instant) && wallTimeAt(instant) === local) candidates.add(instant);
  } else {
    // Both sides of an offset transition can map to the same local time.
    const day = 86_400_000;
    for (const sample of [wall - day, wall, wall + day]) {
      const offsetMs = Date.parse(wallTimeAt(sample) + "Z") - sample;
      const instant = wall - offsetMs;
      if (Number.isFinite(instant) && wallTimeAt(instant) === local) candidates.add(instant);
    }
  }
  if (!candidates.size) throw new ReminderInputError("该当地时间不存在，或 UTC 偏移与时区不符，请用户确认。");
  if (candidates.size > 1) throw new ReminderInputError("夏令时切换使这个当地时间出现两次，请用户确认使用哪个 UTC 偏移。");
  const [second] = candidates;
  const instant = second + Number(fraction.padEnd(3, "0"));
  if (instant <= now) throw new ReminderInputError("提醒时间已过，请选择将来的时间。");
  return instant;
}

function rejectedDelivery(httpStatus, bizCode, attempts, now) {
  if (httpStatus === 429 || bizCode === 40034100) {
    return attempts < 2
      ? { status: "pending", detail: "QQ 限流，等待重试", retryAt: now + RETRY_DELAY_MS }
      : { status: "failed", detail: "QQ 主动消息频率或额度已达上限" };
  }
  if (bizCode === 40034105 || httpStatus === 403) {
    return { status: "failed", detail: "QQ 拒绝主动发送，请检查机器人权限和接收方的主动消息设置" };
  }
  const clientError = httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408;
  const businessError = Number.isSafeInteger(bizCode) && bizCode > 0;
  if (clientError || (httpStatus === undefined && businessError && !String(bizCode).startsWith("5"))) {
    return { status: "failed", detail: `QQ 拒绝发送（${businessError ? bizCode : httpStatus}）` };
  }
  return { status: "unknown", detail: "未取得 QQ 发送回执，结果待核对" };
}

export async function dispatchDueReminder({ store, send, signal, now = Date.now }) {
  signal?.throwIfAborted();
  const started = now();
  const row = store.claimDueReminder(started, started - LATE_WINDOW_MS, started - STALE_SEND_MS);
  if (!row) return;

  // Bound the wait even if an HTTP response body stalls. A late success must
  // never cause a second send after the local outcome becomes uncertain.
  const done = new AbortController();
  const waitSignal = signal ? AbortSignal.any([signal, done.signal]) : done.signal;
  let result;
  try {
    const target = { scope: row.scope, targetId: row.target_id };
    const reply = await Promise.race([
      send(target, `提醒 #${row.id}：${row.content}`),
      delay(SEND_TIMEOUT_MS, null, { signal: waitSignal }),
    ]);
    const code = reply?.code ?? reply?.err_code;
    if (!code && typeof reply?.id === "string" && reply.id.trim()) {
      result = { status: "sent", messageId: reply.id };
    } else {
      result = rejectedDelivery(undefined, code, row.attempts, now());
    }
  } catch (error) {
    result = rejectedDelivery(error?.httpStatus, error?.bizCode, row.attempts, now());
  } finally {
    done.abort();
  }
  // Keep a DB failure after submission out of the transport retry path.
  const status = store.finishReminder(row.id, result);
  console.log(`[reminder] id=${row.id} attempt=${row.attempts} status=${status}`);
}

export async function runReminderScheduler({ store, send, isReady, signal }) {
  while (!signal.aborted) {
    try {
      if (isReady()) await dispatchDueReminder({ store, send, signal });
    } catch (error) {
      console.error("[reminder] scan failed", { name: error?.name, code: error?.code });
    }
    try {
      await delay(SCAN_INTERVAL_MS, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
