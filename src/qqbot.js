import {
  QQBot,
  contentSanitizer,
  mentionGate,
  messageFilter,
} from "@tencent-connect/qqbot-nodejs";

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

export function createQQBot({ qqConfig, ai, memory, state }) {
  const bot = new QQBot({
    appId: qqConfig.appId,
    appSecret: qqConfig.appSecret,
    logger: console,
    markdownSupport: false,
  });

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
        "我是 Qgent ✨ 可以陪你聊天、联网查实时信息，也能真正保存笔记、记账和小确幸。比如：‘午饭 28 元记餐饮’、‘记个笔记：周五交电费’、‘记录今天的小确幸：下班看到了超漂亮的晚霞’。发送 /reset 只清空临时聊天上下文，不会删除已保存记录。",
      );
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
