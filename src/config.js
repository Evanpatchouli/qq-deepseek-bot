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

export const config = {
  qq: {
    appId: required("QQBOT_APP_ID"),
    appSecret: required("QQBOT_APP_SECRET"),
    groupRequireMention: bool("GROUP_REQUIRE_MENTION", true),
  },
  deepseek: {
    apiKey: required("DEEPSEEK_API_KEY"),
    baseURL: process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com",
    model: process.env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash",
    timeoutMs: int("AI_TIMEOUT_MS", 45_000),
    systemPrompt:
      process.env.SYSTEM_PROMPT?.trim() ||
      "你是一个运行在 QQ 中的 AI 助手。请使用简体中文，回答准确、自然、简洁。",
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
