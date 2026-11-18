import { reminderLocalTime } from "./reminders.js";

export class PreferenceInputError extends Error {}

const preferenceHelp = "发送 /prefs 查看偏好，/prefs 名称 内容 保存或修改，/prefs 删除 名称 移除。例如 /prefs 城市 杭州、/prefs 时区 Asia/Shanghai、/prefs 穿衣 怕冷。";
const weatherHelp = "发送 /weather 查看订阅，/weather on 08:00 杭州 每天在本人私聊检查一次天气，/weather off 取消。省略城市时使用已保存的城市或配置的默认地点。";
const weatherResults = {
  waiting: "等待下一次检查。", checking: "本次检查尚未取得结果。",
  no_match: "可用气象数据未触发提醒。", queued: "天气提醒已入队。",
  missed: "已错过本次检查时间。", lookup_failed: "天气查询失败，等待下次检查。",
  stale_report: "天气更新时间无法核对或数据已过期。", location_mismatch: "返回地点未能与订阅城市核对。",
};

export function checkPreferenceName(name) {
  if (typeof name !== "string" || !/^[\p{L}\p{N}_-]{1,24}$/u.test(name) || name === "删除") {
    throw new PreferenceInputError("偏好名称限 1 至 24 个文字、数字、横线或下划线。");
  }
  return name;
}

export function checkCity(city) {
  if (typeof city !== "string" || !city.trim() || city.length > 100 || /[\u0000-\u001f\u007f]/u.test(city)) {
    throw new PreferenceInputError("请提供 1 至 100 个字符的城市或地区名称。");
  }
  return city.trim();
}

export function checkPreference(name, value) {
  checkPreferenceName(name);
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new PreferenceInputError("每项偏好限一行，内容为 1 至 200 个字符。");
  }
  const text = value.trim();
  if (name === "城市") return checkCity(text);
  if (name === "时区") {
    try {
      if (!/^[A-Za-z][A-Za-z0-9_+/\-]*$/u.test(text)) throw new RangeError();
      return new Intl.DateTimeFormat("en", { timeZone: text }).resolvedOptions().timeZone;
    } catch {
      throw new PreferenceInputError("请使用有效的 IANA 时区名称，例如 Asia/Shanghai 或 America/New_York。");
    }
  }
  return text;
}

function preferenceCommand(text) {
  if (text === "/prefs" || text === "查看我的偏好") return { action: "list" };
  if (/^\/prefs(?:\s|$)/u.test(text)) {
    const remove = /^\/prefs\s+删除\s+(\S+)$/u.exec(text);
    if (remove) return { action: "delete", name: remove[1] };
    const set = /^\/prefs\s+(\S+)\s+(.+)$/u.exec(text);
    if (set) return { action: "set", name: set[1], value: set[2] };
    return { action: "help" };
  }
  // Only unambiguous, single-setting requests bypass the model.
  const set = /^(?:请)?(?:记住我的(城市|时区|[\p{L}\p{N}]{1,20}偏好)(?:是|为)|把我的(城市|时区|[\p{L}\p{N}]{1,20}偏好)改[成为])([^，,。！？!?；;\n]+)[。]?$/u.exec(text);
  if (set && !/还是|或者|[吗么呢]$/u.test(set[3])) {
    return { action: "set", name: (set[1] ?? set[2]).replace(/偏好$/u, ""), value: set[3] };
  }
  const remove = /^(?:请)?(?:忘记|删除)我的(城市|时区|[\p{L}\p{N}]{1,20}偏好)[。]?$/u.exec(text);
  if (remove) return { action: "delete", name: remove[1].replace(/偏好$/u, "") };
}

export function handlePersonalCommand({ text, userId, requestId, store, isC2C, weatherAvailable, defaultLocation }) {
  const command = preferenceCommand(text);
  const weatherCommand = /^\/weather(?:\s|$)/u.test(text);
  if (!command && !weatherCommand) return null;
  let operation = weatherCommand ? "qgent_weather_subscription" : "qgent_get_preferences";
  function write(name, args, execute) {
    operation = name;
    return store.executeWriteOnce(userId, requestId, name, args, execute);
  }
  try {
    let answer;
    if (command?.action === "list") {
      const { preferences } = store.listPreferences(userId);
      answer = preferences.length ? "长期偏好\n" + preferences.map((p) => p.name + "　" + p.value).join("\n")
        : "还没有保存长期偏好。";
      answer += "\n" + preferenceHelp;
    } else if (command?.action === "set") {
      const { name, value } = command;
      write("qgent_set_preference", { name, value }, () => store.setPreference(userId, name, value));
      answer = "已保存长期偏好「" + name + "」。";
    } else if (command?.action === "delete") {
      const { name } = command;
      write("qgent_delete_preference", { name }, () => store.deletePreference(userId, name));
      answer = "已删除长期偏好「" + name + "」。";
    } else if (command) {
      return preferenceHelp;
    } else if (!isC2C) {
      return "天气订阅发到本人 QQ 私聊，请在私聊中操作。";
    } else if (text === "/weather") {
      const sub = store.getWeatherSubscription(userId);
      answer = sub?.next_check_at ? `已订阅 ${sub.city}，每天 ${sub.check_time}（${sub.timezone}）检查。\n下次检查 ${reminderLocalTime(sub.next_check_at, sub.timezone)}。\n${weatherResults[sub.last_result]}`
        : "当前没有天气订阅。";
      if (sub?.next_check_at && sub.delivery) {
        answer += `\n最近的天气提醒 #${sub.reminder_id} 状态为 ${sub.delivery}。${sub.delivery_detail ?? ""}`;
      }
      answer += "\n" + weatherHelp;
    } else if (text === "/weather off") {
      write("qgent_cancel_weather_subscription", {}, () => store.cancelWeatherSubscription(userId));
      answer = "已取消天气订阅。";
    } else {
      const match = /^\/weather\s+on\s+(\d{2}:\d{2})(?:\s+(.+))?$/u.exec(text);
      if (!match) return weatherHelp;
      if (!weatherAvailable) throw new PreferenceInputError("天气服务尚未配置，无法开启订阅。");
      const city = checkCity(match[2] ?? store.preferenceValue(userId, "城市") ?? defaultLocation);
      const result = write("qgent_subscribe_weather", { check_time: match[1], city },
        () => store.subscribeWeather(userId, { check_time: match[1], city }));
      answer = `已订阅 ${city} 的天气提醒，每天 ${match[1]}（${result.timezone}）检查一次。遇到降水、低温、高温或明显温差时发到本私聊。发送 /weather off 可取消。`;
    }
    console.log(`[tool] user=${userId} name=${operation} success=true`);
    return answer;
  } catch (error) {
    console.error(`[tool] user=${userId} name=${operation} success=false`, { name: error?.name });
    if (error instanceof PreferenceInputError) return error.message;
    throw error;
  }
}
