import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createQQBot } from "../src/qqbot.js";
import { dispatchDueReminder, reminderTimestamp, runReminderScheduler } from "../src/reminders.js";
import { QgentStore } from "../src/storage.js";
import { executeQgentTool, qgentTools, reminderToolNames } from "../src/tools.js";

const alice = { scope: "c2c", targetId: "alice" };
const group = { scope: "group", targetId: "group-one" };
const tomorrow = Math.ceil(Date.now() / 1000) * 1000 + 86_400_000;

function database(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qgent-reminder-"));
  const store = new QgentStore({ dbPath: path.join(dir, "test.db") });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return store;
}

function argsAt(instant = tomorrow) {
  return { content: "取快递", trigger_at: new Date(instant).toISOString().slice(0, 19), timezone: "UTC" };
}

function tool(store, name, args, target = alice, userId = "alice", requestId) {
  return executeQgentTool({
    store, userId, reminderTarget: target, requestId, call: { name, arguments: JSON.stringify(args) },
  });
}

function byId(store, id, target = alice) {
  return store.listReminders("alice", { id }, target).reminders[0];
}

test("reminder wall clock validation handles calendar dates, gaps and both sides of a clock change", () => {
  const now = Date.UTC(2026, 0, 1);
  const trigger = (value, zone = "Asia/Shanghai") => reminderTimestamp(value, zone, now);
  assert.equal(trigger("2028-02-29T15:00"), Date.parse("2028-02-29T07:00Z"));
  assert.equal(trigger("2028-02-29T07:00:00.123Z"), Date.parse("2028-02-29T15:00:00.123+08:00"));
  assert.equal(trigger("2026-11-01T01:30-04:00", "America/New_York"), Date.parse("2026-11-01T05:30Z"));
  assert.equal(trigger("2026-11-01T01:30-05:00", "America/New_York"), Date.parse("2026-11-01T06:30Z"));
  assert.throws(() => trigger("2026-11-01T01:30", "America/New_York"), /出现两次/);
  assert.throws(() => trigger("2026-03-08T02:30", "America/New_York"), /不存在/);
  assert.throws(() => trigger("2026-11-18T15:00-05:00"), /偏移/);
  assert.throws(() => trigger("2026-11-18T15:00", "Invalid/City"), /时区/);
  assert.throws(() => trigger("2025-12-31T23:59"), /已过/);
  for (const value of ["明天下午", "2026-11-18", "2026-02-29T10:00", "2026-11-18T24:00", "2026-13-01T01:30"]) {
    assert.throws(() => trigger(value));
  }
});

test("reminder tools validate arguments, bind ownership and conversation, and reuse write receipts", async (t) => {
  const store = database(t);
  for (const schema of qgentTools.filter((item) => reminderToolNames.has(item.name))) {
    assert.equal(schema.parameters.additionalProperties, false);
    for (const key of schema.parameters.required ?? []) assert.ok(Object.hasOwn(schema.parameters.properties, key));
  }
  const create = (args, target = group) => tool(store, "qgent_create_reminder", args, target, "alice", "g:msg-1");
  const args = { ...argsAt(), content: "O'Brien 在群里取件" };
  const first = await create(args);
  assert.equal(first.status, "pending");
  assert.equal((await create(args)).duplicate, true);
  assert.equal(store.listReminders("alice", {}, group).count, 1);
  for (const bad of [{ ...args, content: " " }, { ...args, content: "a".repeat(501) }, { ...args, target_id: "elsewhere" },
    { ...args, user_id: "bob" }, { ...args, trigger_at: "2026-02-30T12:00" }]) {
    await assert.rejects(create(bad));
  }
  for (const target of [null, { scope: "guild", targetId: "room" }, { scope: "group", targetId: "" },
    { scope: "c2c", targetId: "bob" }]) await assert.rejects(create(args, target));
  for (const [target, user] of [[group, "bob"], [alice, "alice"], [{ scope: "group", targetId: "other" }, "alice"]]) {
    assert.equal((await tool(store, "qgent_list_reminders", {}, target, user)).count, 0);
    await assert.rejects(tool(store, "qgent_cancel_reminder", { id: first.id }, target, user, "cancel"));
  }
  for (const id of [0, -1, 1.2, "1 OR 1=1"]) await assert.rejects(tool(store, "qgent_cancel_reminder", { id }, group));
  assert.equal(byId(store, first.id, group).content, args.content);
  const cancel = () => tool(store, "qgent_cancel_reminder", { id: first.id }, group, "alice", "g:msg-2");
  assert.equal((await cancel()).status, "cancelled");
  assert.equal((await cancel()).duplicate, true);
  assert.equal((await tool(store, "qgent_list_reminders", { status: "cancelled" }, group)).count, 1);
  await dispatchDueReminder({ store, now: () => tomorrow, send: () => assert.fail("cancelled reminder") });
  assert.equal(byId(store, first.id, group).status, "cancelled");
  assert.equal(store.getWriteReceipts("alice").length, 2);
});

test("a legacy database upgrades in place and a restart sends only reminders inside the catch-up window", async (t) => {
  const store = database(t);
  store.addNote("alice", { content: "原有笔记" });
  store.db.exec("DROP TABLE reminders");
  store.close();
  const upgraded = new QgentStore({ dbPath: store.dbPath });
  assert.equal(upgraded.searchNotes("alice").notes[0].content, "原有笔记");
  const late = upgraded.addReminder("alice", argsAt(tomorrow - 16 * 60_000), alice);
  const due = upgraded.addReminder("alice", argsAt(tomorrow - 60_000), alice);
  const future = upgraded.addReminder("alice", argsAt(tomorrow + 60_000), alice);
  upgraded.close();
  const reopened = new QgentStore({ dbPath: store.dbPath });
  t.after(() => reopened.close());
  const sends = [];
  const tick = () => dispatchDueReminder({ store: reopened, now: () => tomorrow,
    send: async (target, text) => { sends.push({ target, text }); return { id: "receipt" }; } });
  await tick();
  await tick();
  assert.deepEqual(sends, [{ target: alice, text: `提醒 #${due.id}：取快递` }]);
  assert.equal(byId(reopened, late.id).status, "expired");
  assert.equal(byId(reopened, due.id).status, "sent");
  assert.equal(byId(reopened, future.id).status, "pending");
});

test("the atomic claim prevents concurrent sends or cancellation of an in-flight reminder", async (t) => {
  const store = database(t);
  const { id } = store.addReminder("alice", argsAt(), alice);
  let acknowledge;
  const sending = dispatchDueReminder({ store, now: () => tomorrow, send: () => new Promise((r) => { acknowledge = r; }) });
  const other = new QgentStore({ dbPath: store.dbPath });
  t.after(() => other.close());
  assert.equal(byId(other, id).status, "sending");
  assert.throws(() => other.cancelReminder("alice", { id }, alice), /可取消/);
  await dispatchDueReminder({ store: other, now: () => tomorrow, send: () => assert.fail("duplicate claim") });
  acknowledge({ id: "accepted" });
  await sending;
  assert.equal(byId(other, id).status, "sent");
});

test("an accepted send with a failed SQLite update recovers as unknown and never sends again", async (t) => {
  const store = database(t);
  const { id } = store.addReminder("alice", argsAt(), alice);
  t.mock.method(store, "finishReminder", () => { throw new Error("disk I/O"); });
  await assert.rejects(dispatchDueReminder({ store, now: () => tomorrow, send: async () => ({ id: "accepted" }) }), /I\/O/);
  store.close();
  const reopened = new QgentStore({ dbPath: store.dbPath });
  t.after(() => reopened.close());
  await dispatchDueReminder({ store: reopened, now: () => tomorrow + 120_000, send: () => assert.fail("ambiguous send replayed") });
  assert.equal(byId(reopened, id).status, "unknown");
});

test("only explicit rate rejection retries, after a delay, at most once and still cancellable", async (t) => {
  const store = database(t);
  const { id } = store.addReminder("alice", argsAt(), alice);
  let attempts = 0;
  const limited = async () => {
    attempts++;
    throw Object.assign(new Error("private error response"), attempts === 1 ? { httpStatus: 429 } : { httpStatus: 400, bizCode: 40034100 });
  };
  const tick = (offset) => dispatchDueReminder({ store, now: () => tomorrow + offset, send: limited });
  await tick(0);
  assert.equal(byId(store, id).status, "pending");
  await tick(59_999);
  assert.equal(attempts, 1);
  await tick(60_000);
  await tick(120_000);
  assert.equal(attempts, 2);
  assert.equal(byId(store, id).status, "failed");
  assert.match(byId(store, id).detail, /额度/);
  const another = store.addReminder("alice", argsAt(), alice);
  await tick(120_000);
  store.cancelReminder("alice", { id: another.id }, alice);
  await tick(200_000);
  assert.equal(attempts, 3);
});

for (const [label, send, expected] of [
  ["permission denied", async () => { throw Object.assign(new Error("private details"), { httpStatus: 400, bizCode: 40034105 }); }, "failed"],
  ["HTTP 401", async () => { throw Object.assign(new Error("private details"), { httpStatus: 401 }); }, "failed"],
  ["server error", async () => { throw Object.assign(new Error("private details"), { httpStatus: 503 }); }, "unknown"],
  ["network timeout", async () => { throw new Error("private details"); }, "unknown"],
  ["missing QQ receipt", async () => ({}), "unknown"],
  ["explicit QQ error body", async () => ({ err_code: 304064, message: "private details" }), "failed"],
]) {
  test(`${label} records a safe outcome without retry`, async (t) => {
    const store = database(t);
    const { id } = store.addReminder("alice", argsAt(), alice);
    await dispatchDueReminder({ store, now: () => tomorrow, send });
    const retry = t.mock.fn(async () => ({ id: "unexpected" }));
    await dispatchDueReminder({ store, now: () => tomorrow + 60_000, send: retry });
    assert.equal(retry.mock.callCount(), 0);
    const record = byId(store, id);
    assert.equal(record.status, expected);
    assert.doesNotMatch(record.detail, /private details/);
  });
}

test("the daily limit is shared across group members and leaves other recipients eligible", async (t) => {
  const store = database(t);
  store.db.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<1000)
    INSERT INTO reminders(user_id, scope, target_id, content, trigger_at, timezone, status, created_at,
      next_attempt_at, attempts, last_attempt_at)
    SELECT 'bob','group',?,'old',?,'UTC','sent','old',?,1,? FROM n`)
    .run(group.targetId, tomorrow - 60_000, tomorrow - 60_000, tomorrow - 60_000);
  const blocked = store.addReminder("alice", argsAt(), group);
  const eligible = store.addReminder("alice", argsAt(), alice);
  const targets = [];
  await dispatchDueReminder({ store, now: () => tomorrow, send: async (target) => { targets.push(target); return { id: "sent" }; } });
  assert.deepEqual(targets, [alice]);
  assert.equal(byId(store, blocked.id, group).status, "pending");
  assert.equal(byId(store, eligible.id).status, "sent");
});

test("SDK posts proactive plain text to the documented endpoints without reply or wakeup fields", async (t) => {
  const store = database(t);
  const bot = createQQBot({ qqConfig: { appId: "fake", appSecret: "fake", balanceAllowedOpenIds: ["alice"] },
    ai: { store }, state: {} });
  t.mock.method(bot.tokenManager, "getAccessToken", async () => "test-token");
  const posts = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    posts.push({ path: new URL(url).pathname, method: options.method, body: JSON.parse(options.body) });
    return Response.json({ id: "qq-message" });
  });
  for (const [target, endpoint] of [[alice, "/v2/users/alice/messages"], [group, "/v2/groups/group-one/messages"]]) {
    const { id } = store.addReminder("alice", argsAt(), target);
    await dispatchDueReminder({ store, now: () => tomorrow, send: (to, text) => bot.sendText(to, text) });
    assert.deepEqual(posts.at(-1), { path: endpoint, method: "POST", body: { msg_type: 0, content: `提醒 #${id}：取快递` } });
    assert.equal(byId(store, id, target).status, "sent");
  }
  assert.equal(posts.length, 2);
});

test("stopping the scheduler during a send preserves uncertainty and exits before storage closes", async (t) => {
  const store = database(t);
  const { id } = store.addReminder("alice", argsAt(), alice);
  t.mock.method(Date, "now", () => tomorrow);
  const controller = new AbortController();
  let resolveSend;
  const loop = runReminderScheduler({ store, isReady: () => true, signal: controller.signal,
    send: () => new Promise((r) => { resolveSend = r; }) });
  assert.equal(byId(store, id).status, "sending");
  controller.abort();
  await loop;
  assert.equal(byId(store, id).status, "unknown");
  resolveSend({ id: "late" });
  await dispatchDueReminder({ store, now: () => tomorrow + 60_000, send: () => assert.fail("duplicate after stop") });
});
