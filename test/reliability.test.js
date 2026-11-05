import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { QgentStore } from "../src/storage.js";
import { executeQgentTool } from "../src/tools.js";
import { DeepSeekClient } from "../src/deepseek.js";
import { createQQBot } from "../src/qqbot.js";
import { ConversationMemory } from "../src/memory.js";
import { createMessageQueue } from "../src/message-queue.js";

function database(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qgent-reliability-"));
  const dbPath = path.join(dir, "test.db");
  const store = new QgentStore({ dbPath });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return store;
}
const call = (args = { content: "私人笔记" }) => ({ name: "qgent_add_note", call_id: "1", arguments: JSON.stringify(args) });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function aiClient(options = {}) {
  return new DeepSeekClient({ apiKey: "fake", model: "fake", systemPrompt: "test", timeoutMs: 1000, ...options });
}
function harness(t, chat) {
  const store = database(t);
  const memory = new ConversationMemory();
  const handlers = {};
  const replies = [];
  const middleware = [];
  const bot = { use: (fn) => middleware.push(fn), on: (event, fn) => { handlers[event] = fn; },
    sendText: async (target, content) => { replies.push({ target, content }); }, sendTyping: async () => {} };
  createQQBot({ qqConfig: { appId: "test", appSecret: "fake", groupRequireMention: true, balanceAllowedOpenIds: ["a"] },
    ai: { chat, store }, memory, state: { messagesProcessed: 0 }, botFactory: () => bot });
  const message = (id, content, senderId = "a", extra = {}) => ({ kind: "c2c", senderId, messageId: id, content,
    replyTarget: { targetId: senderId, scope: "c2c" }, ...extra });
  return { store, memory, bot, replies, middleware, message, send: (msg) => handlers.message({}, msg) };
}

test("write receipts survive restart, isolate users and distinguish intentional records", async (t) => {
  const store = database(t);
  const execute = (userId, requestId, args) => executeQgentTool({ call: call(args), userId, requestId, store });
  const first = await execute("a", "m1");
  const duplicate = await execute("a", "m1");
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.duplicate, true);
  store.close();
  const reopened = new QgentStore({ dbPath: store.dbPath });
  assert.equal(reopened.getWriteReceipts("a", "m1")[0].id, first.id);
  assert.equal(reopened.getWriteReceipts("b", "m1").length, 0);
  const replay = await executeQgentTool({ call: call(), userId: "a", requestId: "m1", store: reopened });
  assert.equal(replay.id, first.id);
  reopened.close();
  // Reopen original object for remaining assertions and cleanup.
  const other = new QgentStore({ dbPath: store.dbPath });
  t.after(() => other.close());
  for (const [userId, requestId, args] of [["b", "m1"], ["a", "m2"], ["a", "m1", { content: "私人笔记", record_key: "second" }]]) {
    await executeQgentTool({ call: call(args), userId, requestId, store: other });
  }
  assert.equal(other.searchNotes("a").count, 3);
  assert.equal(other.searchNotes("b").count, 1);
});

test("failed transactional writes roll back both record and receipt", (t) => {
  const store = database(t);
  assert.throws(() => store.executeWriteOnce("a", "m1", "qgent_add_note", {}, () => {
    store.addNote("a", { content: "must roll back" });
    throw new Error("disk failure");
  }));
  assert.equal(store.searchNotes("a").count, 0);
  assert.equal(store.getWriteReceipts("a").length, 0);
});

test("tool arguments fail before persistence", async (t) => {
  const store = database(t);
  const invalid = ["null", "[]", "{", '{"content":3}', '{"content":""}', '{"content":"x","user_id":"b"}'];
  for (const raw of invalid) await assert.rejects(executeQgentTool({ call: { ...call(), arguments: raw }, userId: "a", store }));
  for (const args of [{ type: "expense", amount: "10" }, { type: "expense", amount: 1, occurred_on: "2026-02-30" }]) {
    await assert.rejects(executeQgentTool({ call: { name: "qgent_add_ledger", arguments: JSON.stringify(args) }, userId: "a", store }));
  }
  assert.equal(store.searchNotes("a").count, 0);
});

test("AI total deadline cancels API and prohibits later tool writes", async (t) => {
  const store = database(t);
  const client = aiClient({ timeoutMs: 20, store });
  let signal;
  const api = deferred();
  client.client.responses.create = (_, options) => { signal = options.signal; return api.promise; };
  await assert.rejects(client.chat({ history: [], prompt: "记一下", userId: "a", requestId: "m" }), /超时/);
  assert.equal(signal.aborted, true);
  api.resolve({ output: [{ type: "function_call", ...call() }] });
  await new Promise((r) => setImmediate(r));
  assert.equal(store.searchNotes("a").count, 0);
});

test("AI total deadline includes external weather tool waiting", async () => {
  let toolSignal;
  const client = aiClient({ timeoutMs: 20, weather: { getWeather: (_, { signal }) => {
    toolSignal = signal; return new Promise(() => {});
  } } });
  let requests = 0;
  client.client.responses.create = async () => { requests++; return { output: [{ type: "function_call", name: "qgent_get_weather", call_id: "w", arguments: '{"city":"北京"}' }] }; };
  await assert.rejects(client.chat({ history: [], prompt: "天气", userId: "a" }), /超时/);
  assert.equal(toolSignal.aborted, true);
  assert.equal(requests, 1);
});

test("AI repeated tool calls reuse receipt and failures retain saved IDs", async (t) => {
  const store = database(t);
  const client = aiClient({ store });
  let requests = 0;
  client.client.responses.create = async (request) => {
    requests++;
    if (requests === 3) { assert.equal(JSON.parse(request.input.at(-1).output).duplicate, true); throw new Error("HTTP 500"); }
    return { output: [{ type: "function_call", ...call(), call_id: String(requests) }] };
  };
  await assert.rejects(client.chat({ history: [], prompt: "记录", userId: "a", requestId: "m" }), (error) => error.savedResults.length === 1);
  assert.equal(store.searchNotes("a").count, 1);
});

for (const response of [{ status: "incomplete", output_text: "已保存" }, { output_text: "" },
  { output: [{ type: "web_search_call", status: "failed" }], output_text: "最新天气" }]) {
  test("AI rejects incomplete, empty or failed search results", async () => {
    const client = aiClient(); client.client.responses.create = async () => response;
    await assert.rejects(client.chat({ history: [], prompt: "test", userId: "a" }));
  });
}

test("round exhaustion never returns provisional claims or executes final calls", async (t) => {
  const store = database(t);
  const client = aiClient({ store, maxToolRounds: 1 });
  client.client.responses.create = async () => ({ output_text: "已保存", output: [{ type: "function_call", ...call() }] });
  await assert.rejects(client.chat({ history: [], prompt: "保存", userId: "a", requestId: "m" }), /round limit/);
  assert.equal(store.searchNotes("a").count, 0);
});

test("messages and reset retain arrival order while other users progress", async (t) => {
  const gate = deferred();
  const started = deferred();
  const histories = [];
  const h = harness(t, async ({ prompt, history }) => {
    histories.push([prompt, history.length]);
    if (prompt === "first") { started.resolve(); await gate.promise; }
    return "answer";
  });
  h.store.addNote("a", { content: "persistent" });
  const first = h.send(h.message("1", "first"));
  await started.promise;
  const reset = h.send(h.message("2", "/reset"));
  const next = h.send(h.message("3", "next"));
  await h.send(h.message("4", "other", "b"));
  assert.deepEqual(histories, [["first", 0], ["other", 0]]);
  gate.resolve(); await Promise.all([first, reset, next]);
  assert.deepEqual(histories.at(-1), ["next", 0]);
  assert.equal(h.store.searchNotes("a").count, 1);
});

test("QQ send failure and redelivery reuse saved answer; status reports only current user", async (t) => {
  let calls = 0;
  const h = harness(t, async ({ userId, requestId }) => {
    calls++;
    await executeQgentTool({ call: call(), userId, requestId, store: h.store });
    return "保存成功";
  });
  const originalSend = h.bot.sendText;
  h.bot.sendText = async () => { throw new Error("SDK private error"); };
  await h.send(h.message("1", "保存"));
  h.bot.sendText = originalSend;
  await h.send(h.message("1", "保存"));
  assert.equal(calls, 1);
  assert.equal(h.replies.at(-1).content, "保存成功");
  await h.send(h.message("2", "/status"));
  assert.match(h.replies.at(-1).content, /笔记 #1/);
  await h.send(h.message("3", "/status", "b"));
  assert.doesNotMatch(h.replies.at(-1).content, /#1/);
});

test("command send failures, empty, oversized and self messages are contained", async (t) => {
  const h = harness(t, () => assert.fail("no AI request"));
  await h.send(h.message("1", " "));
  await h.send(h.message("2", "self", "a", { senderIsBot: true }));
  await h.send(h.message("3", "x".repeat(8001)));
  assert.match(h.replies.at(-1).content, /8000/);
  await h.send(h.message("4", "/help"));
  assert.match(h.replies.at(-1).content, /\/status/);
  h.bot.sendText = async () => { throw new Error("HTTP 401 secret"); };
  await h.send(h.message("5", "/reset"));
});

test("bounded queue and rate limits reject excess without poisoning later jobs", async () => {
  const enqueue = createMessageQueue({ capacity: 2, perConversation: 1 });
  const gate = deferred();
  const first = enqueue("a", [["user:a", 2]], () => gate.promise);
  await assert.rejects(enqueue("a", [], () => {}), /队列/);
  const second = enqueue("b", [], async () => { throw new Error("failure"); });
  await assert.rejects(second, /failure/);
  gate.resolve(); await first;
  await new Promise((r) => setImmediate(r));
  await enqueue("a", [["user:a", 2]], async () => {});
  await new Promise((r) => setImmediate(r));
  await assert.rejects(enqueue("a", [["user:a", 2]], () => {}), /频繁/);
});

test("group mention filtering runs before sanitizing; Guild and DM still reply", async (t) => {
  const h = harness(t, async ({ prompt }) => `回答 ${prompt}`);
  const dispatch = async (message) => {
    const ctx = { message, bot: { appId: "test" }, state: {}, log: {}, stop() {} };
    const next = (i) => i === h.middleware.length ? h.send(ctx.message) : h.middleware[i](ctx, () => next(i + 1));
    await next(0);
  };
  await dispatch(h.message("g1", "不@", "a", { kind: "group", groupOpenid: "g" }));
  assert.equal(h.replies.length, 0);
  await dispatch(h.message("g2", "<@test> 你好", "a", { kind: "group", groupOpenid: "g" }));
  assert.equal(h.replies.at(-1).content, "回答 你好");
  await dispatch(h.message("g3", "<@test> 自回声", "a", { kind: "group", groupOpenid: "g", senderIsBot: true }));
  assert.equal(h.replies.length, 1);
  h.bot.messageApi = {
    sendChannelMessage: async (args) => h.replies.push(args),
    sendDmMessage: async (args) => h.replies.push(args),
  };
  await dispatch(h.message("guild1", "频道", "a", { kind: "guild", channelId: "channel" }));
  assert.equal(h.replies.at(-1).channelId, "channel");
  await dispatch(h.message("dm1", "私信", "a", { kind: "dm", guildId: "guild" }));
  assert.equal(h.replies.at(-1).guildId, "guild");
});

test("redelivered reset cannot erase newer conversation turns", async (t) => {
  const h = harness(t, async () => "answer");
  await h.send(h.message("reset", "/reset"));
  await h.send(h.message("next", "hello"));
  await h.send(h.message("reset", "/reset"));
  assert.equal(h.memory.get("c2c:a").length, 2);
});

test("tool execution failures reach AI without private error details", async () => {
  const client = aiClient({ store: { addNote: () => { throw new Error("SQLITE_BUSY private data"); } } });
  let requests = 0;
  client.client.responses.create = async (request) => {
    if (++requests === 1) return { output: [{ type: "function_call", ...call() }] };
    const result = JSON.parse(request.input.at(-1).output);
    assert.equal(result.success, false);
    assert.equal(result.error.includes("private data"), false);
    return { output_text: "保存失败" };
  };
  assert.equal(await client.chat({ history: [], prompt: "test", userId: "a" }), "保存失败");
});

for (const [name, args, read] of [
  ["qgent_add_ledger", { type: "expense", amount: 12.34 }, (store, user) => store.listLedger(user).count],
  ["qgent_add_moment", { content: "开心的一天" }, (store, user) => store.listMoments(user).count],
]) {
  test(`${name} retries once per message and remains user isolated`, async (t) => {
    const store = database(t);
    for (const userId of ["a", "a", "b"]) {
      await executeQgentTool({ call: { name, arguments: JSON.stringify(args) }, userId, requestId: "m", store });
    }
    assert.equal(read(store, "a"), 1);
    assert.equal(read(store, "b"), 1);
    assert.equal(read(store, "c"), 0);
  });
}

test("total AI budget does not reset between response requests", async () => {
  const client = aiClient({ timeoutMs: 100, weather: { getWeather: async () => ({ success: true }) } });
  let requests = 0;
  let secondSignal;
  client.client.responses.create = async (_, { signal }) => {
    requests++;
    if (requests === 1) {
      await new Promise((r) => setTimeout(r, 60));
      return { output: [{ type: "function_call", name: "qgent_get_weather", call_id: "w", arguments: '{"city":"北京"}' }] };
    }
    secondSignal = signal;
    return new Promise(() => {});
  };
  await assert.rejects(client.chat({ history: [], prompt: "test", userId: "a" }), /超时/);
  assert.equal(requests, 2);
  assert.equal(secondSignal.aborted, true);
});
