import {
  QQBot,
  contentSanitizer,
  mentionGate,
  messageFilter,
} from "@tencent-connect/qqbot-nodejs";
import { createMessageQueue } from "./message-queue.js";
import { formatDeepSeekBalance } from "./balance.js";

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
    return bot.sendText(msg.replyTarget, content);
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

function savedStatus(results) {
  if (!results.length) return "没有查到已成功保存的工具记录。";
  const labels = { qgent_add_note: "笔记", qgent_add_ledger: "账目", qgent_add_moment: "小确幸" };
  return "已保存：" + results.map((item) => `${labels[item.name] || "记录"} #${item.id}`).join("、") + "。可直接查询核对，不要重复提交。";
}

export function createQQBot({ qqConfig, ai, balance, memory, state, store = ai.store, botFactory = (options) => new QQBot(options) }) {
  const bot = botFactory({
    appId: qqConfig.appId,
    appSecret: qqConfig.appSecret,
    logger: console,
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
    const replyCommand = async (content) => {
      store?.saveMessageResult(msg.senderId, requestId, content);
      return sendReply(bot, qqConfig, msg, content);
    };
    const cached = store?.getMessageResult(msg.senderId, requestId);
    if (cached) {
      await sendReply(bot, qqConfig, msg, cached);
      return;
    }
    const receipts = store?.getWriteReceipts(msg.senderId, requestId) ?? [];
    if (receipts.length) {
      await sendReply(bot, qqConfig, msg, `${savedStatus(receipts)} 上次处理未完整结束。`);
      return;
    }
    if (text === "/status") {
      await replyCommand(savedStatus(store?.getWriteReceipts(msg.senderId) ?? []));
      return;
    }

    if (text === "/reset") {
      memory.clear(key);
      await replyCommand("这段聊天上下文清空啦。持久化的笔记、账本和小确幸不会被删掉喔。");
      return;
    }

    if (text === "/help") {
      await replyCommand(
        "我是 Qgent ✨ 可以陪你聊天、联网查实时信息，也能真正保存笔记、记账和小确幸。/status 查看最近保存结果。私聊发送 /balance 可以查询 DeepSeek API 余额；/reset 只清空临时聊天上下文。",
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
      if (msg.kind === "c2c" && msg.replyTarget) {
        bot.sendTyping(msg.replyTarget, 20).catch(() => {});
      }

      const history = memory.get(key);
      const answer = await ai.chat({
        history,
        prompt: text,
        userId: msg.senderId,
        requestId,
      });
      // Save before sending: QQ failures must never rerun a completed write.
      store?.saveMessageResult(msg.senderId, requestId, answer);
      memory.appendTurn(key, text, answer);
      await sendReply(bot, qqConfig, msg, answer);

      state.messagesProcessed += 1;
      state.lastMessageAt = new Date().toISOString();
      console.log(
        `[message] kind=${msg.kind} sender=${msg.senderId} elapsed=${Date.now() - startedAt}ms`,
      );
    } catch (error) {
      state.lastError = error?.name || "Error";
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
