/** Queries UAPI weather without exposing credentials to the model. */
export class WeatherClient {
  constructor({ apiKey = "", timeoutMs = 10_000, extended = false, fetchImpl = globalThis.fetch } = {}) {
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.extended = extended;
    this.fetchImpl = fetchImpl;
  }

  /** Fetch current weather for an explicit city; never use server IP location. */
  async getWeather(args) {
    if (!args || typeof args !== "object" || Array.isArray(args) ||
        Object.keys(args).some((key) => key !== "city") ||
        typeof args.city !== "string" || !args.city.trim() ||
        args.city.length > 100 || /[\u0000-\u001f]/u.test(args.city)) {
      throw new Error("天气查询需要明确的城市或地区名称（1–100 字符）");
    }
    if (!this.apiKey) throw new Error("天气服务未配置 UAPI_API_KEY");
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
        signal: controller.signal,
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
        throw new Error(messages[response.status] || `天气服务暂时不可用（HTTP ${response.status}）`);
      }
      let data;
      try { data = await response.json(); } catch {
        if (controller.signal.aborted) throw new Error("天气查询超时，请稍后再试");
        throw new Error("天气服务返回了无效 JSON");
      }
      if (!data || typeof data.city !== "string" || !data.city.trim() ||
          typeof data.weather !== "string" || !data.weather.trim() ||
          typeof data.temperature !== "number" || !Number.isFinite(data.temperature) ||
          typeof data.report_time !== "string" || !data.report_time.trim()) {
        throw new Error("天气服务返回的数据不完整，无法确认实时天气");
      }
      const weather = {};
      for (const key of ["province", "city", "district", "adcode", "weather", "temperature",
        "wind_direction", "wind_power", "humidity", "report_time", "feels_like", "uv",
        "precipitation", "aqi", "temp_max", "temp_min", "forecast", "life_indices", "alerts"]) {
        if (data[key] !== undefined) weather[key] = data[key];
      }
      return { success: true, source: "UAPI", source_url: "https://uapis.cn/docs/api-reference/get-misc-weather",
        requested_city: args.city.trim(), weather };
    } catch (error) {
      if (controller.signal.aborted) throw new Error("天气查询超时，请稍后再试");
      // Never forward fetch errors, response bodies or credentials to the model/logs.
      if (error instanceof Error && error.message.startsWith("天气") || error?.message === "未找到该地区的天气数据") throw error;
      throw new Error("无法连接天气服务，请稍后再试");
    } finally {
      clearTimeout(timer);
    }
  }
}
