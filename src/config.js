function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function int(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function csv(name) {
  const raw = process.env[name]?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export const config = {
  qq: {
    appId: required("QQBOT_APP_ID"),
    appSecret: required("QQBOT_APP_SECRET"),
    groupRequireMention: bool("GROUP_REQUIRE_MENTION", true),
    balanceAllowedOpenIds: csv("QGENT_BALANCE_ALLOWED_OPENIDS"),
  },
  deepseek: {
    apiKey: required("DEEPSEEK_API_KEY"),
    baseURL: process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com",
    balanceBaseURL:
      process.env.DEEPSEEK_BALANCE_BASE_URL?.trim() || "https://api.deepseek.com",
    model: process.env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash",
    timeoutMs: int("AI_TIMEOUT_MS", 45_000),
    balanceTimeoutMs: int("DEEPSEEK_BALANCE_TIMEOUT_MS", 10_000),
    webSearchEnabled: bool("DEEPSEEK_WEB_SEARCH", true),
    defaultLocation: process.env.QGENT_DEFAULT_LOCATION?.trim() || "",
    timeZone: process.env.QGENT_TIMEZONE?.trim() || "Asia/Shanghai",
    maxToolRounds: int("QGENT_MAX_TOOL_ROUNDS", 5),
    systemPrompt:
      process.env.SYSTEM_PROMPT?.trim() ||
      "你叫 Qgent，是一个运行在 QQ 中的个人 AI 小助手。请使用简体中文，回答准确、自然、简洁。",
  },
  storage: {
    dbPath: process.env.QGENT_DB_PATH?.trim() || "./data/qgent.db",
    timeZone: process.env.QGENT_TIMEZONE?.trim() || "Asia/Shanghai",
  },
  memory: {
    maxTurns: int("MAX_HISTORY_TURNS", 8),
    ttlMs: int("HISTORY_TTL_MINUTES", 120) * 60_000,
  },
  health: {
    host: process.env.HEALTH_HOST?.trim() || "0.0.0.0",
    port: int("HEALTH_PORT", 3000),
  },
};
