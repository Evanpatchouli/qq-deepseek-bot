import {
  QQBot,
  contentSanitizer,
  mentionGate,
  messageFilter,
} from "@tencent-connect/qqbot-nodejs";
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

export function createQQBot({ qqConfig, ai, balance, memory, state }) {
  const bot = new QQBot({
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

  bot.use(messageFilter({ skipSelfEcho: true, dedup: { windowMs: 5000 } }));
  bot.use(contentSanitizer({ stripBotMention: true }));
  bot.use(mentionGate({ requireMentionInGroup: qqConfig.groupRequireMention }));

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
    state.lastError = String(error?.stack || error);
    console.error("[qq]", error);
  });

  bot.on("message", async (_ctx, msg) => {
    const text = msg.content?.trim();
    if (!text) return;

    const key = conversationKey(msg);

    if (text === "/reset") {
      memory.clear(key);
      await sendReply(bot, qqConfig, msg, "这段聊天上下文清空啦。持久化的笔记、账本和小确幸不会被删掉喔。");
      return;
    }

    if (text === "/help") {
      await sendReply(
        bot,
        qqConfig,
        msg,
        "我是 Qgent ✨ 可以陪你聊天、联网查实时信息，也能真正保存笔记、记账和小确幸。私聊发送 /balance 可以查询 DeepSeek API 余额；/reset 只清空临时聊天上下文。",
      );
      return;
    }

    if (text === "/balance" || text === "余额查询") {
      if (msg.kind !== "c2c") {
        await sendReply(bot, qqConfig, msg, "余额属于账户信息，这个功能只在私聊里开放喔。");
        return;
      }

      if (!balanceAuthorized(qqConfig, msg)) {
        console.warn(`[balance] unauthorized sender=${msg.senderId}`);
        await sendReply(bot, qqConfig, msg, "哼，这个可是主人的小金库信息，只给主人看～");
        return;
      }

      try {
        const data = await balance.getBalance();
        const content = formatDeepSeekBalance(data);
        await sendReply(bot, qqConfig, msg, content);
        console.log(`[balance] sender=${msg.senderId} success=true`);
      } catch (error) {
        console.error("[balance] failed", error);
        await sendReply(
          bot,
          qqConfig,
          msg,
          `余额暂时没查到：${error?.message || "未知错误"}`,
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
      });
      await sendReply(bot, qqConfig, msg, answer);
      memory.appendTurn(key, text, answer);

      state.messagesProcessed += 1;
      state.lastMessageAt = new Date().toISOString();
      console.log(
        `[message] kind=${msg.kind} sender=${msg.senderId} elapsed=${Date.now() - startedAt}ms`,
      );
    } catch (error) {
      state.lastError = String(error?.stack || error);
      console.error("[message] failed", error);
      try {
        await sendReply(bot, qqConfig, msg, "唔，Qgent 刚刚卡了一下，请稍后再试一次。");
      } catch (replyError) {
        console.error("[message] fallback reply failed", replyError);
      }
    }
  });

  return bot;
}
