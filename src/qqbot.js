import {
  QQBot,
  contentSanitizer,
  mentionGate,
  messageFilter,
} from "@tencent-connect/qqbot-nodejs";
import { createMessageQueue } from "./message-queue.js";
import { formatDeepSeekBalance } from "./balance.js";
import { RecordInputError, recordLabel, RecordTurn, savedStatus } from "./records.js";
import { handlePersonalCommand } from "./preferences.js";

function conversationKey(msg) {
  if (msg.kind === "c2c") return `c2c:${msg.senderId}`;
  if (msg.kind === "group") {
    const groupId = msg.groupOpenid || msg.replyTarget?.targetId || "unknown";
    return `group:${groupId}:user:${msg.senderId}`;
  }
  if (msg.kind === "guild") return `guild:${msg.channelId || "unknown"}:user:${msg.senderId}`;
  if (msg.kind === "dm") return `dm:${msg.guildId || "unknown"}:user:${msg.senderId}`;
  return `${msg.kind}:${msg.senderId}`;
}

async function sendReply(bot, qqConfig, msg, content) {
  if ((msg.kind === "c2c" || msg.kind === "group") && msg.replyTarget) {
    return bot.sendText({ ...msg.replyTarget, msgId: msg.messageId }, content);
  }

  const creds = { appId: qqConfig.appId, clientSecret: qqConfig.appSecret };

  if (msg.kind === "guild" && msg.channelId) {
    return bot.messageApi.sendChannelMessage({
      channelId: msg.channelId,
      content,
      creds,
      msgId: msg.messageId,
    });
  }

  if (msg.kind === "dm" && msg.guildId) {
    return bot.messageApi.sendDmMessage({
      guildId: msg.guildId,
      content,
      creds,
      msgId: msg.messageId,
    });
  }

  throw new Error(`Unsupported QQ message kind: ${msg.kind}`);
}

function balanceAuthorized(qqConfig, msg) {
  if (msg.kind !== "c2c") return false;
  const allowed = qqConfig.balanceAllowedOpenIds || [];
  return allowed.length === 0 || allowed.includes(msg.senderId);
}

export function createQQBot({ qqConfig, ai, balance, memory, state, store = ai.store, botFactory = (options) => new QQBot(options) }) {
  const bot = botFactory({
    appId: qqConfig.appId,
    appSecret: qqConfig.appSecret,
    // SDK debug logs include the full HTTP request and response bodies.
    logger: { info: console.info, warn: console.warn, error: console.error },
    markdownSupport: false,
  });

  if ((qqConfig.balanceAllowedOpenIds || []).length === 0) {
    console.warn(
      "[security] QGENT_BALANCE_ALLOWED_OPENIDS is empty; /balance is available to any C2C user",
    );
  }

  // Persistent message results handle redelivery, including failed sends.
  bot.use(messageFilter({ skipSelfEcho: true, dedup: false }));
  bot.use(mentionGate({ requireMentionInGroup: qqConfig.groupRequireMention }));
  bot.use(contentSanitizer({ stripBotMention: true }));

  bot.on("ready", () => {
    state.ready = true;
    state.lastReadyAt = new Date().toISOString();
    console.log("[qq] connected");
  });

  bot.on("resumed", () => {
    state.ready = true;
    console.log("[qq] resumed");
  });

  bot.on("error", (error) => {
    state.lastError = error?.name || "Error";
    console.error("[qq] failed", { name: error?.name, status: error?.status });
  });

  const enqueue = createMessageQueue();
  async function processMessage(msg) {
    const text = msg.content?.trim();
    if (!text) return;

    const key = conversationKey(msg);
    const requestId = `${key}:message:${msg.messageId}`;
    const replyWithoutNewReferences = (content) => {
      // An older replay or a command can show different IDs from the last AI turn.
      memory.clearRecordReferences(key, requestId);
      return sendReply(bot, qqConfig, msg, content);
    };
    const replyCommand = async (content) => {
      store?.saveMessageResult(msg.senderId, requestId, content);
      return replyWithoutNewReferences(content);
    };
    const cached = store?.getMessageResult(msg.senderId, requestId);
    if (cached) {
      await replyWithoutNewReferences(cached);
      return;
    }
    const receipts = store?.getWriteReceipts(msg.senderId, requestId) ?? [];
    if (receipts.length) {
      await replyWithoutNewReferences(`${savedStatus(receipts)} 上次处理未完整结束。`);
      return;
    }
    if (text === "/status") {
      await replyCommand(savedStatus(store?.getWriteReceipts(msg.senderId, null, key) ?? []));
      return;
    }

    if (text === "/reset") {
      memory.clear(key);
      await replyCommand("这段聊天上下文清空啦。长期偏好、账本、笔记、小确幸、提醒和天气订阅都还在。");
      return;
    }

    if (text === "/help") {
      await replyCommand(
        "我是 Qgent ✨ 可以陪你聊天、查天气、记笔记、记账和保存小确幸。可以说“回顾我这周的生活”“把账目 #3 改为 18 元”或“删除小确幸 #1”，删除记录前会请你确认。私聊或群聊里可以说“明天下午三点在这里提醒我取快递”“查看我的提醒”或“取消提醒 #3”。群里创建的提醒会发到原群。\n/prefs 查看和管理长期偏好，例如 /prefs 城市 杭州。私聊 /weather 管理天气订阅，/balance 查余额。/status 查看最近操作，/reset 清空临时聊天上下文。",
      );
      return;
    }

    if (text === "/balance" || text === "余额查询") {
      if (msg.kind !== "c2c") {
        await replyCommand("余额属于账户信息，这个功能只在私聊里开放喔。");
        return;
      }

      if (!balanceAuthorized(qqConfig, msg)) {
        console.warn(`[balance] unauthorized sender=${msg.senderId}`);
        await replyCommand("哼，这个可是主人的小金库信息，只给主人看～");
        return;
      }

      try {
        const data = await balance.getBalance();
        const content = formatDeepSeekBalance(data);
        await replyCommand(content);
        console.log(`[balance] sender=${msg.senderId} success=true`);
      } catch (error) {
        console.error("[balance] failed", { name: error?.name });
        await sendReply(
          bot,
          qqConfig,
          msg,
          "余额暂时没查到，请稍后再试。",
        );
      }
      return;
    }

    const startedAt = Date.now();
    try {
      const personalReply = handlePersonalCommand({ text, userId: msg.senderId, requestId, store,
        isC2C: msg.kind === "c2c", weatherAvailable: Boolean(ai.weather?.apiKey), defaultLocation: ai.defaultLocation });
      if (personalReply !== null) {
        await replyCommand(personalReply);
        return;
      }
      const lastRecords = memory.getRecordState(key);
      const confirmation = /^确认删除(?:\s+([a-z0-9]+))?$/iu.exec(text.normalize("NFKC"));
      if (confirmation) {
        const pending = lastRecords?.deletion;
        let answer;
        try {
          if (!pending || pending.code !== confirmation[1]?.toLowerCase()) {
            throw new RecordInputError("没有匹配的删除确认，请在原会话复制预览中的完整确认指令，或重新发起删除。");
          }
          const result = store.confirmRecordDeletion(msg.senderId, requestId, pending);
          answer = `已删除${recordLabel(result.kind, result.id)}。`;
          memory.appendTurn(key, "确认删除" + recordLabel(result.kind, result.id), answer);
          console.log(`[tool] user=${msg.senderId} name=qgent_delete_record kind=${result.kind} id=${result.id} success=true`);
        } catch (error) {
          console.error(`[tool] user=${msg.senderId} name=qgent_delete_record success=false`, { name: error?.name });
          if (!(error instanceof RecordInputError)) throw error;
          answer = error.message;
        }
        await replyCommand(answer);
        return;
      }
      if (msg.kind === "c2c" && msg.replyTarget) {
        bot.sendTyping(msg.replyTarget, 20).catch(() => {});
      }

      const history = memory.get(key);
      const recordTurn = new RecordTurn(text, lastRecords?.references);
      let reminderTarget;
      if (msg.kind === "c2c") reminderTarget = { scope: "c2c", targetId: msg.senderId };
      if (msg.kind === "group" && msg.groupOpenid) reminderTarget = { scope: "group", targetId: msg.groupOpenid };
      const answer = await ai.chat({
        history,
        prompt: text,
        userId: msg.senderId,
        requestId,
        recordTurn,
        reminderTarget,
        messageTimestamp: msg.timestamp,
      });
      // Save before sending: QQ failures must never rerun a completed write.
      store?.saveMessageResult(msg.senderId, requestId, answer);
      memory.appendTurn(key, text, answer, { ...recordTurn.state, requestId });
      await sendReply(bot, qqConfig, msg, answer);

      state.messagesProcessed += 1;
      state.lastMessageAt = new Date().toISOString();
      console.log(
        `[message] kind=${msg.kind} sender=${msg.senderId} elapsed=${Date.now() - startedAt}ms`,
      );
    } catch (error) {
      state.lastError = error?.name || "Error";
      memory.clearRecordReferences(key);
      console.error("[message] failed", { name: error?.name, status: error?.status });
      try {
        const saved = store?.getWriteReceipts(msg.senderId, requestId) ?? error.savedResults ?? [];
        await sendReply(bot, qqConfig, msg, saved.length
          ? `这次处理或回复未完整完成。${savedStatus(saved)} 也可发送 /status 查看。`
          : "这次处理未完成，没有确认保存成功；请先查询记录或发送 /status 核对，再决定是否重试。");
      } catch (replyError) {
        console.error("[message] fallback reply failed", { name: replyError?.name });
      }
    }
  }

  bot.on("message", async (_ctx, msg) => {
    if (typeof msg.content !== "string" || !msg.content.trim() || msg.senderIsBot) return;
    if (typeof msg.senderId !== "string" || !msg.senderId.trim() ||
        typeof msg.messageId !== "string" || !msg.messageId.trim()) {
      console.warn("[message] missing sender or message identity; ignored");
      return;
    }
    try {
      if (msg.content.length > 8000) {
        await sendReply(bot, qqConfig, msg, "消息太长啦，请拆成 8000 字符以内再发。");
        return;
      }
      const rateKeys = [[`user:${msg.senderId}`, 20]];
      if (msg.kind === "group") rateKeys.push([`group:${msg.groupOpenid || msg.replyTarget?.targetId}`, 60]);
      await enqueue(conversationKey(msg), rateKeys, () => processMessage(msg));
    } catch (error) {
      state.lastError = "QQ message processing or delivery failed";
      console.error("[message] processing or delivery failed", { name: error?.name });
      // Queue errors are controlled text; never send raw SDK errors or stacks.
      if (error?.message === "消息队列已满，请稍后再试。" || error?.message === "消息太频繁，请一分钟后再试。") {
        try { await sendReply(bot, qqConfig, msg, error.message); } catch { console.error("[qq] busy reply failed"); }
      }
    }
  });

  return bot;
}
