function cleanBaseURL(value) {
  return String(value || "https://api.deepseek.com").replace(/\/+$/, "");
}

function safeJsonText(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/**
 * Calls DeepSeek's account balance endpoint without consuming chat tokens.
 */
export class DeepSeekBalanceClient {
  constructor({
    apiKey,
    baseURL = "https://api.deepseek.com",
    timeoutMs = 10_000,
    fetchImpl = globalThis.fetch,
  }) {
    if (!apiKey) throw new Error("DeepSeekBalanceClient requires apiKey");
    if (typeof fetchImpl !== "function") throw new Error("Global fetch is unavailable");

    this.apiKey = apiKey;
    this.baseURL = cleanBaseURL(baseURL);
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  /**
   * Fetches the current account balance from DeepSeek.
   * @returns {Promise<object>} DeepSeek balance response.
   */
  async getBalance() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response;
    try {
      response = await this.fetchImpl(`${this.baseURL}/user/balance`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error("查询 DeepSeek 余额超时，请稍后再试");
      }
      throw new Error(`无法连接 DeepSeek 余额接口：${error?.message || error}`);
    } finally {
      clearTimeout(timer);
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      // 下面会按 HTTP 状态返回更友好的错误。
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error("DeepSeek API Key 无效，或当前 Key 无权查询余额");
      }
      if (response.status === 429) {
        throw new Error("DeepSeek 余额接口请求过于频繁，请稍后再试");
      }

      const detail = data?.error?.message || data?.message || safeJsonText(data);
      throw new Error(
        `DeepSeek 余额查询失败（HTTP ${response.status}）${detail ? `：${detail}` : ""}`,
      );
    }

    if (!data || typeof data.is_available !== "boolean" || !Array.isArray(data.balance_infos)) {
      throw new Error("DeepSeek 余额接口返回了无法识别的数据格式");
    }

    return data;
  }
}

function moneySymbol(currency) {
  if (currency === "CNY") return "¥";
  if (currency === "USD") return "$";
  return "";
}

function money(currency, value) {
  const symbol = moneySymbol(currency);
  return `${symbol}${value ?? "0"}`;
}

/**
 * Formats a validated DeepSeek balance response for QQ text messages.
 * @param {object} data DeepSeek balance response.
 * @returns {string} Human-readable balance text.
 */
export function formatDeepSeekBalance(data) {
  const lines = [
    "💰 DeepSeek API 余额",
    `状态：${data.is_available ? "可用 ✅" : "不可用 ⚠️"}`,
  ];

  if (data.balance_infos.length === 0) {
    lines.push("暂无余额明细。");
    return lines.join("\n");
  }

  for (const item of data.balance_infos) {
    const currency = item.currency || "未知币种";
    lines.push("");
    lines.push(`${currency}：${money(currency, item.total_balance)}`);
    lines.push(`充值余额：${money(currency, item.topped_up_balance)}`);
    lines.push(`赠送余额：${money(currency, item.granted_balance)}`);
  }

  return lines.join("\n");
}
