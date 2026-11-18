export class WeatherError extends Error {}

// The same measured thresholds drive advice on demand and opt-in reminders.
function weatherTips({ temperature, feels_like, precipitation }, forecast = false) {
  const tips = [];
  const measured = Number.isFinite(feels_like) ? feels_like : temperature;
  const label = Number.isFinite(feels_like) ? "体感" : "气温";
  if (Number.isFinite(measured) && measured <= 5) tips.push(`${label} ${measured}℃，出门加件保暖外套。`);
  if (Number.isFinite(measured) && measured >= 32) tips.push(`${label} ${measured}℃，选择轻薄透气的衣物。`);
  if (Number.isFinite(precipitation) && precipitation > 0) {
    tips.push(`${forecast ? "预报" : "实况"}降水量 ${precipitation} 毫米，出门可带雨具。`);
  }
  return tips;
}

export function weatherGuidance(weather) {
  const current = weatherTips(weather);
  const forecast = [];
  for (const day of Array.isArray(weather.forecast) ? weather.forecast.slice(0, 7) : []) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(day?.date)) continue;
    const tips = weatherTips({ precipitation: day.precip }, true);
    if (Number.isFinite(day.temp_min) && day.temp_min <= 5) tips.push(`预报最低 ${day.temp_min}℃，早晚注意保暖。`);
    if (Number.isFinite(day.temp_max) && day.temp_max >= 32) tips.push(`预报最高 ${day.temp_max}℃，白天宜穿轻薄衣物。`);
    if (Number.isFinite(day.temp_max) && Number.isFinite(day.temp_min) && day.temp_max - day.temp_min >= 10) {
      tips.push(`预报 ${day.temp_min}～${day.temp_max}℃，温差较大，可分层穿衣。`);
    }
    if (tips.length) forecast.push({ date: day.date, tips });
  }
  return { current, forecast };
}

/** Queries UAPI weather without exposing credentials to the model. */
export class WeatherClient {
  constructor({ apiKey = "", timeoutMs = 10_000, extended = false, fetchImpl = globalThis.fetch } = {}) {
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.extended = extended;
    this.fetchImpl = fetchImpl;
  }

  /** Fetch current weather for an explicit city; never use server IP location. */
  async getWeather(args, { signal } = {}) {
    signal?.throwIfAborted();
    if (!args || typeof args !== "object" || Array.isArray(args) ||
        Object.keys(args).some((key) => key !== "city") ||
        typeof args.city !== "string" || !args.city.trim() ||
        args.city.length > 100 || /[\u0000-\u001f]/u.test(args.city)) {
      throw new WeatherError("天气查询需要明确的城市或地区名称（1–100 字符）");
    }
    if (!this.apiKey) throw new WeatherError("天气服务未配置 UAPI_API_KEY");
    const url = new URL("https://uapis.cn/api/v1/misc/weather");
    url.searchParams.set("city", args.city.trim());
    url.searchParams.set("lang", "zh");
    if (this.extended) {
      for (const key of ["extended", "forecast", "indices"]) url.searchParams.set(key, "true");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        headers: { Accept: "application/json", Authorization: `Bearer ${this.apiKey}` },
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      });
      if (!response.ok) {
        const messages = {
          400: "天气查询地点无效，请提供更明确的城市名称",
          401: "天气服务 API Key 无效或已过期",
          402: "天气服务账户额度不足",
          403: "天气服务 API Key 权限不足，请检查接口权限或扩展字段权限",
          404: "未找到该地区的天气数据",
          429: "天气服务请求过于频繁或额度已用完，请稍后再试",
        };
        throw new WeatherError(messages[response.status] || `天气服务暂时不可用（HTTP ${response.status}）`);
      }
      let data;
      try { data = await response.json(); } catch {
        if (controller.signal.aborted) throw new WeatherError("天气查询超时，请稍后再试");
        throw new WeatherError("天气服务返回了无效 JSON");
      }
      if (!data || typeof data.city !== "string" || !data.city.trim() ||
          typeof data.weather !== "string" || !data.weather.trim() ||
          typeof data.temperature !== "number" || !Number.isFinite(data.temperature) ||
          typeof data.report_time !== "string" || !data.report_time.trim()) {
        throw new WeatherError("天气服务返回的数据不完整，无法确认实时天气");
      }
      const weather = {};
      for (const key of ["province", "city", "district", "adcode", "weather", "temperature",
        "wind_direction", "wind_power", "humidity", "report_time", "feels_like", "uv",
        "precipitation", "aqi", "temp_max", "temp_min", "forecast", "life_indices", "alerts"]) {
        if (data[key] !== undefined) weather[key] = data[key];
      }
      return { success: true, source: "UAPI", source_url: "https://uapis.cn/docs/api-reference/get-misc-weather",
        requested_city: args.city.trim(), weather, guidance: weatherGuidance(weather) };
    } catch (error) {
      if (controller.signal.aborted) throw new WeatherError("天气查询超时，请稍后再试");
      // Never forward fetch errors, response bodies or credentials to the model/logs.
      if (error instanceof WeatherError) throw error;
      throw new WeatherError("无法连接天气服务，请稍后再试");
    } finally {
      clearTimeout(timer);
    }
  }
}
