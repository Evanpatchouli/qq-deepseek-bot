import { config } from "./config.js";
import { ConversationMemory } from "./memory.js";
import { DeepSeekClient } from "./deepseek.js";
import { DeepSeekBalanceClient } from "./balance.js";
import { QgentStore } from "./storage.js";
import { startHealthServer } from "./health.js";
import { createQQBot } from "./qqbot.js";

const state = {
  ready: false,
  startedAt: new Date().toISOString(),
  lastReadyAt: null,
  lastMessageAt: null,
  messagesProcessed: 0,
  lastError: null,
};

const memory = new ConversationMemory(config.memory);
const store = new QgentStore(config.storage);
const ai = new DeepSeekClient({ ...config.deepseek, store });
const balance = new DeepSeekBalanceClient({
  apiKey: config.deepseek.apiKey,
  baseURL: config.deepseek.balanceBaseURL,
  timeoutMs: config.deepseek.balanceTimeoutMs,
});
const bot = createQQBot({ qqConfig: config.qq, ai, balance, memory, state });

const healthServer = startHealthServer({
  ...config.health,
  getStatus: () => ({
    ok: state.ready,
    ready: state.ready,
    model: config.deepseek.model,
    activeConversations: memory.size,
    persistentStorage: true,
    ...state,
  }),
});

const abortController = new AbortController();
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[app] ${signal}, shutting down...`);
  state.ready = false;
  abortController.abort();
  healthServer.close();
  store.close();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

const cleanupTimer = setInterval(() => memory.clearExpired(), 10 * 60_000);
cleanupTimer.unref();

try {
  await bot.start(abortController.signal);
} catch (error) {
  state.ready = false;
  state.lastError = String(error?.stack || error);
  console.error("[app] fatal", error);
  process.exitCode = 1;
} finally {
  clearInterval(cleanupTimer);
  healthServer.close();
  store.close();
}
