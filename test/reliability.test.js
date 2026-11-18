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

test("QQ reminders use the inbound conversation through the AI loop, survive reset and report cancellation", async (t) => {
  const client = aiClient();
  const h = harness(t, (input) => client.chat(input));
  client.store = h.store;
  const actions = {
    "记提醒": ["qgent_create_reminder", { content: "取快递", trigger_at: "2099-01-02T15:00" }],
    "看提醒": ["qgent_list_reminders", {}],
    "取消提醒": ["qgent_cancel_reminder", { id: 1 }],
    "时间有误": ["qgent_create_reminder", { content: "取快递", trigger_at: "2000-01-01T15:00" }],
  };
  const results = [];
  client.client.responses.create = async ({ input, instructions, tools }) => {
    const last = input.at(-1);
    if (last.type === "function_call_output") {
      results.push(JSON.parse(last.output));
      return { output_text: "工具返回结果已收到" };
    }
    if (last.content === "频道消息") {
      assert.ok(!tools.some((tool) => tool.name === "qgent_create_reminder"));
      assert.match(instructions, /当前会话无法/);
      return { output_text: "请在私聊设置提醒" };
    }
    assert.ok(tools.some((tool) => tool.name === "qgent_create_reminder"));
    assert.ok(tools.some((tool) => tool.type === "web_search"));
    if (last.content === "记提醒") assert.match(instructions, /15:12:34/);
    const [name, args] = actions[last.content];
    return { output: [{ type: "function_call", call_id: "reminder", name, arguments: JSON.stringify(args) }] };
  };
  const sendGroup = (id, text, sender = "a") => h.send(h.message(id, text, sender, { kind: "group", groupOpenid: "g", timestamp: "2099-01-01T15:12:34+08:00",
    replyTarget: { scope: "group", targetId: "g", msgId: id } }));
  await sendGroup("m1", "记提醒");
  await sendGroup("m1", "记提醒");
  assert.equal(results.length, 1);
  assert.equal(results[0].scope, "group");
  assert.equal(results[0].timezone, "Asia/Shanghai");
  assert.equal(results[0].trigger_at, "2099-01-02T07:00:00.000Z");
  assert.deepEqual(h.replies.at(-1).target, { scope: "group", targetId: "g", msgId: "m1" });
  await sendGroup("m2", "/reset");
  await sendGroup("m3", "看提醒");
  assert.equal(results.at(-1).reminders[0].status, "pending");
  await sendGroup("m4", "看提醒", "b");
  assert.equal(results.at(-1).count, 0);
  await h.send(h.message("private", "看提醒"));
  assert.equal(results.at(-1).count, 0);
  await sendGroup("m5", "取消提醒");
  assert.equal(results.at(-1).status, "cancelled");
  await sendGroup("m6", "/status");
  assert.match(h.replies.at(-1).content, /取消提醒 #1/);
  assert.match(h.replies.at(-1).content, /登记提醒 #1/);
  await h.send(h.message("private-status", "/status"));
  assert.doesNotMatch(h.replies.at(-1).content, /#1/);
  await sendGroup("m7", "时间有误");
  assert.equal(results.at(-1).success, false);
  assert.match(results.at(-1).error, /时间已过/);
  h.bot.messageApi = { sendChannelMessage: async (args) => h.replies.push(args) };
  await h.send(h.message("guild", "频道消息", "a", { kind: "guild", channelId: "channel" }));
  assert.equal(h.replies.at(-1).content, "请在私聊设置提醒");
});

test("a reminder tool loop hits the total round limit without creating duplicate reminders", async (t) => {
  const store = database(t);
  const client = aiClient({ store, maxToolRounds: 2 });
  let requests = 0;
  client.client.responses.create = async () => ({ output: [{ type: "function_call", call_id: String(++requests),
    name: "qgent_create_reminder", arguments: '{"content":"取快递","trigger_at":"2099-01-02T15:00"}' }] });
  const target = { scope: "c2c", targetId: "a" };
  await assert.rejects(client.chat({ history: [], prompt: "提醒我", userId: "a", requestId: "m", reminderTarget: target }), /round limit/);
  assert.equal(requests, 2);
  assert.equal(store.listReminders("a", {}, target).count, 1);
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

function recordBot(t, actions) {
  const client = aiClient();
  const h = harness(t, (input) => client.chat(input));
  client.store = h.store;
  const outputs = [];
  client.client.responses.create = async ({ input }) => {
    const last = input.at(-1);
    if (last.type === "function_call_output") {
      outputs.push(JSON.parse(last.output));
      return { output_text: "处理完毕" };
    }
    const [name, args] = actions[last.content];
    return { output: [{ type: "function_call", call_id: "record", name, arguments: JSON.stringify(args) }] };
  };
  const say = async (id, content, sender = "a", extra) => {
    await h.send(h.message(id, content, sender, extra));
    return h.replies.at(-1)?.content;
  };
  return { ...h, say, outputs };
}

test("QQ uses verified record IDs across turns, asks before ambiguous edits and reports failed writes truthfully", async (t) => {
  const h = recordBot(t, {
    "午饭 28 元记一下": ["qgent_add_ledger", { type: "expense", amount: 28 }],
    "刚才那笔不是 28，是 18": ["qgent_update_ledger", { id: 1, expected_amount: 28, amount: 18 }],
    "查看笔记": ["qgent_search_notes", {}],
    "那条笔记加一句带上发票": ["qgent_update_note", { id: 1, append_content: "带上发票" }],
    "笔记 #2": ["qgent_update_note", { id: 2, append_content: "带上发票" }],
    "改笔记 #99": ["qgent_update_note", { id: 99, content: "错" }],
    "查看笔记 #2": ["qgent_get_record", { kind: "note", id: 2 }],
  });
  h.store.addNote("a", { content: "报销交通费" });
  h.store.addNote("a", { content: "报销住宿费" });
  h.store.addNote("b", { content: "其他用户的秘密" });
  assert.match(await h.say("1", "午饭 28 元记一下"), /已保存账目 #1/);
  assert.match(await h.say("2", "刚才那笔不是 28，是 18"), /已修改账目 #1/);
  assert.equal(h.outputs.at(-1).record.amount, 18);
  assert.equal(h.store.ledgerSummary("a").expense, 18);
  await h.say("3", "查看笔记");
  const choice = await h.say("4", "那条笔记加一句带上发票");
  assert.match(choice, /请选定/);
  assert.match(choice, /笔记 #1.*报销交通费/);
  assert.match(choice, /笔记 #2.*报销住宿费/);
  assert.doesNotMatch(choice, /秘密|已修改/);
  assert.equal(h.store.getWriteReceipts("a", "c2c:a:message:4").length, 0);
  const changed = await h.say("5", "笔记 #2");
  assert.match(changed, /已修改笔记 #2/);
  assert.equal(await h.say("5", "笔记 #2"), changed);
  await h.say("6", "/reset");
  await h.say("7", "查看笔记 #2");
  assert.equal(h.outputs.at(-1).record.content, "报销住宿费\n带上发票");
  assert.equal(h.store.getRecord("a", { kind: "note", id: 1 }).record.content, "报销交通费");
  assert.match(await h.say("8", "改笔记 #99"), /没有这个编号/);
  assert.match(await h.say("9", "/status"), /修改笔记 #2/);
});

test("QQ deletion requires a fresh user message matching the owner's preview in the same conversation", async (t) => {
  const h = recordBot(t, {
    "撤销小确幸 #1": ["qgent_prepare_record_deletion", { kind: "moment", id: 1 }],
    "把小确幸 #1 改成晴天": ["qgent_update_moment", { id: 1, content: "晴天" }],
  });
  h.store.addMoment("a", { content: "晚霞" });
  const group = { kind: "group", groupOpenid: "g", replyTarget: { scope: "group", targetId: "g" } };
  const otherGroup = { ...group, groupOpenid: "g2", replyTarget: { scope: "group", targetId: "g2" } };
  const preview = async (id, expectedContent) => {
    const text = await h.say(id, "撤销小确幸 #1", "a", group);
    assert.match(text, /待删除的记录/);
    assert.ok(text.includes(expectedContent));
    assert.equal(h.store.listMoments("a").count, 1);
    return text.match(/确认删除 [a-f0-9]{8}/u)[0];
  };
  const first = await preview("p1", "晚霞");
  assert.match(await h.say("wrong-user", first, "b", group), /没有匹配/);
  assert.match(await h.say("wrong-qq", first), /没有匹配/);
  assert.match(await h.say("wrong-group", first, "a", otherGroup), /没有匹配/);
  assert.match(await h.say("guess", "确认删除", "a", group), /没有匹配/);
  await h.say("edit", "把小确幸 #1 改成晴天");
  assert.match(await h.say("changed", first, "a", group), /预览后已修改/);
  const second = await preview("p2", "晴天");
  await h.say("reset", "/reset", "a", group);
  assert.match(await h.say("after-reset", second, "a", group), /没有匹配/);
  assert.equal(h.store.listMoments("a").count, 1);
  const final = await preview("p3", "晴天");
  assert.match(await h.say("delete", final, "a", group), /已删除小确幸 #1/);
  assert.equal(await h.say("delete", final, "a", group), "已删除小确幸 #1。");
  assert.match(await h.say("repeat", final, "a", group), /没有匹配/);
  assert.equal(h.store.listMoments("a").count, 0);
  assert.equal(h.store.getWriteReceipts("a", "group:g:user:a:message:delete").length, 1);
  assert.match(await h.say("status", "/status", "a", group), /删除小确幸 #1/);
});

test("exhausting an edit tool loop leaves one durable append and an accurate QQ fallback", async (t) => {
  const client = aiClient({ maxToolRounds: 3 });
  const h = harness(t, (input) => client.chat(input));
  client.store = h.store;
  h.store.addNote("a", { content: "报销" });
  let rounds = 0;
  client.client.responses.create = async () => ({ output: [{ type: "function_call", call_id: String(++rounds),
    name: "qgent_update_note", arguments: '{"id":1,"append_content":"发票"}' }] });
  const message = h.message("edit", "笔记 #1 加一句发票");
  await h.send(message);
  assert.equal(rounds, 3);
  assert.match(h.replies.at(-1).content, /未完整完成.*修改笔记 #1/);
  await h.send(message);
  assert.equal(rounds, 3);
  assert.match(h.replies.at(-1).content, /修改笔记 #1/);
  assert.equal(h.store.searchNotes("a").notes[0].content, "报销\n发票");
});

test("a status reply or an older QQ replay cannot silently retarget the next relative edit", async (t) => {
  const h = recordBot(t, {
    "记笔记 1": ["qgent_add_note", { content: "第一条" }],
    "记笔记 2": ["qgent_add_note", { content: "第二条" }],
    "查看笔记 #2": ["qgent_get_record", { kind: "note", id: 2 }],
    "那条笔记加一句": ["qgent_update_note", { id: 2, append_content: "追加" }],
  });
  await h.say("1", "记笔记 1");
  await h.say("2", "记笔记 2");
  await h.say("2", "记笔记 2");
  assert.match(await h.say("3", "那条笔记加一句"), /已修改笔记 #2/);
  await h.say("status", "/status");
  assert.match(await h.say("4", "那条笔记加一句"), /请选定/);
  await h.say("5", "查看笔记 #2");
  await h.say("1", "记笔记 1");
  assert.match(await h.say("6", "那条笔记加一句"), /请选定/);
  assert.equal(h.store.getRecord("a", { kind: "note", id: 2 }).record.content, "第二条\n追加");
});

test("a delete preview reports earlier committed writes and stops the rest of a mixed tool batch", async (t) => {
  const store = database(t);
  store.addNote("a", { content: "旧的清单" });
  const client = aiClient({ store });
  const actions = [
    ["qgent_create_reminder", { content: "买牛奶", trigger_at: "2099-01-02T15:00" }],
    ["qgent_prepare_record_deletion", { kind: "note", id: 1 }],
    ["qgent_add_note", { content: "后续请求" }],
  ];
  client.client.responses.create = async () => ({ output: actions.map(([name, args], i) =>
    ({ type: "function_call", call_id: String(i), name, arguments: JSON.stringify(args) })) });
  const reply = await client.chat({ history: [], prompt: "提醒我买牛奶，再撤销笔记 #1。", userId: "a", requestId: "m",
    reminderTarget: { scope: "c2c", targetId: "a" } });
  assert.match(reply, /待删除的记录/);
  assert.match(reply, /登记提醒 #1/);
  assert.match(reply, /后续操作尚未执行/);
  assert.equal(store.searchNotes("a").count, 1);
});
