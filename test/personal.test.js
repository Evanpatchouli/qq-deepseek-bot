import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { QgentStore, createDatabaseSnapshot } from "../src/storage.js";
import { dateRange, noteTimeBounds } from "../src/dates.js";
import { DeepSeekClient } from "../src/deepseek.js";
import { executeQgentTool, qgentTools } from "../src/tools.js";

function database(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qgent-personal-"));
  const store = new QgentStore({ dbPath: path.join(dir, "test.db"), timeZone: "UTC" });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return store;
}

const tool = (name, args, context) => executeQgentTool({ userId: "alice", ...context,
  call: { name, arguments: JSON.stringify(args) } });

test("preferences and subscriptions upgrade in place and survive backup, restore and reopening", (t) => {
  const old = database(t);
  old.addNote("alice", { content: "旧数据" });
  old.db.exec("DROP TABLE weather_subscriptions; DROP TABLE user_preferences; DROP INDEX idx_notes_user_timestamp");
  old.close();
  const store = new QgentStore({ dbPath: old.dbPath });
  t.after(() => store.close());
  assert.equal(store.searchNotes("alice").count, 1);
  store.setPreference("alice", "城市", "西安");
  store.setPreference("alice", "穿衣", "O'Brien 的外套");
  store.subscribeWeather("alice", { city: "西安", check_time: "08:00" });
  const copy = old.dbPath + ".backup";
  createDatabaseSnapshot({ sourcePath: old.dbPath, destinationPath: copy });
  const restored = new QgentStore({ dbPath: copy });
  t.after(() => restored.close());
  assert.equal(restored.preferenceValue("alice", "城市"), "西安");
  assert.equal(restored.preferenceValue("alice", "穿衣"), "O'Brien 的外套");
  assert.equal(restored.getWeatherSubscription("alice").city, "西安");
  assert.deepEqual(restored.listPreferences("bob").preferences, []);
  assert.equal(restored.getWeatherSubscription("bob"), undefined);
});

test("each named preference validates, updates and deletes only the authenticated user's value", (t) => {
  const store = database(t);
  for (const [name, value] of [["时区", "Mars/Home"], ["时区", "+08:00"], ["城市", "  "], ["城市", "a".repeat(101)],
    ["生活", "x\ny"], ["生活", "x".repeat(201)], ["生活;SQL", "x"]]) {
    assert.throws(() => store.setPreference("alice", name, value));
  }
  store.setPreference("alice", "时区", "America/New_York");
  store.setPreference("bob", "时区", "Asia/Shanghai");
  assert.throws(() => store.deletePreference("stranger", "时区"));
  for (let n = 0; n < 11; n++) store.setPreference("alice", "偏好" + n, "a");
  assert.throws(() => store.setPreference("alice", "再加一项", "b"), /12/);
  store.setPreference("alice", "偏好1", "x'); --");
  assert.equal(store.listPreferences("alice", { name: "偏好1" }).preferences[0].value, "x'); --");
  store.deletePreference("alice", "时区");
  assert.equal(store.userTimeZone("alice"), "UTC");
  assert.equal(store.userTimeZone("bob"), "Asia/Shanghai");
});

test("local date ranges follow Monday weeks, leap months, and 23/25 hour days", () => {
  const time = Date.parse("2024-03-01T03:00Z");
  assert.equal(dateRange({ period: "this_month" }, "America/New_York", time).end, "2024-02-29");
  assert.equal(dateRange({ period: "last_month" }, "Asia/Shanghai", time).end, "2024-02-29");
  assert.deepEqual(dateRange({ period: "last_week" }, "UTC", time),
    { label: "last_week", start: "2024-02-19", end: "2024-02-25" });
  assert.equal(dateRange({ period: "last_7_days" }, "UTC", time).start, "2024-02-24");
  assert.deepEqual(noteTimeBounds({ start: "2026-11-01", end: "2026-11-01" }, "America/New_York"),
    ["2026-11-01T04:00:00.000Z", "2026-11-02T04:59:59.999Z"]);
  assert.deepEqual(noteTimeBounds({ start: "2026-03-08", end: "2026-03-08" }, "America/New_York"),
    ["2026-03-08T05:00:00.000Z", "2026-03-09T03:59:59.999Z"]);
});

test("reviews count every in-range owned row, return bounded excerpts and database ledger totals", async (t) => {
  const store = database(t);
  const referenceTime = Date.parse("2026-11-02T04:59:59Z");
  store.setPreference("alice", "时区", "America/New_York");
  for (const [time, content] of [["2026-11-01T03:59:59.999Z", "前一天"], ["2026-11-01T04:00:00.000Z", "当天开头"],
    ["2026-11-02T04:59:59.999Z", "末".repeat(500)], ["2026-11-02T05:00:00.000Z", "后一天"]]) {
    store.nowIso = () => time;
    store.addNote("alice", { title: "标题", content });
    store.addNote("bob", { content: "其他人的笔记" });
  }
  for (const [type, amount] of [["expense", 0.1], ["expense", 0.2], ["income", 1]]) {
    await tool("qgent_add_ledger", { type, amount }, { store, referenceTime });
  }
  store.addLedgerEntry("alice", { type: "expense", amount: 600, occurred_on: "2026-11-02" });
  store.addLedgerEntry("bob", { type: "expense", amount: 600, occurred_on: "2026-11-01" });
  await tool("qgent_add_moment", { content: "晚霞" }, { store, referenceTime });
  store.addMoment("bob", { content: "其他人的小确幸", occurred_on: "2026-11-01" });
  const run = (args) => tool("qgent_life_review", args, { store, referenceTime });
  const review = await run({ period: "today", limit: 1 });
  assert.equal(review.start_date, "2026-11-01");
  assert.equal(review.timezone, "America/New_York");
  assert.equal(review.ledger.count, 3);
  assert.equal(review.ledger.expense, 0.3);
  assert.equal(review.ledger.balance, 0.7);
  assert.equal(review.ledger.top_expense_categories[0].amount, 0.3);
  assert.equal(review.notes.total, 2);
  assert.equal(review.notes.records.length, 1);
  assert.equal(review.notes.records[0].truncated, true);
  assert.equal(review.notes.records[0].excerpt.length, 240);
  assert.equal(review.notes.records[0].local_date, "2026-11-01");
  assert.equal(review.moments.records[0].excerpt, "晚霞");
  assert.doesNotMatch(JSON.stringify(review), /其他人的|前一天|后一天/);
  const only = await run({ kind: "note", start_date: "2026-10-01", end_date: "2026-10-30" });
  assert.deepEqual(only.notes, { total: 0, records: [] });
  assert.equal(only.ledger, undefined);
  assert.equal(only.moments, undefined);
  const other = await tool("qgent_life_review", { period: "all" }, { store, userId: "stranger" });
  assert.equal(other.ledger.count + other.notes.total + other.moments.total, 0);
  for (const args of [{ kind: "user" }, { user_id: "bob" }, { limit: 11 }, { period: "hmm" },
    { start_date: "2026-02-30" }, { start_date: "2026-02-01", end_date: "2026-01-01" }]) await assert.rejects(run(args));
  for (const name of ["qgent_get_preferences", "qgent_life_review"]) {
    const { parameters } = qgentTools.find((item) => item.name === name);
    assert.equal(parameters.additionalProperties, false);
    assert.ok(!Object.hasOwn(parameters.properties, "user_id"));
  }
  await assert.rejects(tool("qgent_get_preferences", { user_id: "bob" }, { store }));
});

test("DeepSeek receives current review evidence and scoped preferences as tool data in the user's timezone", async (t) => {
  const store = database(t);
  store.setPreference("alice", "穿衣", "怕冷");
  store.setPreference("alice", "时区", "America/New_York");
  store.setPreference("bob", "穿衣", "其他人的偏好");
  store.addMoment("alice", { content: "看晚霞", occurred_on: "2026-11-01" });
  const ai = new DeepSeekClient({ store, model: "test", apiKey: "test", maxToolRounds: 2 });
  ai.client.responses.create = async ({ instructions, input, tools }) => {
    assert.match(instructions, /America\/New_York/);
    assert.doesNotMatch(instructions, /怕冷|其他人的偏好/);
    assert.ok(!tools.some(({ name }) => name === "qgent_set_preference" || name === "qgent_subscribe_weather"));
    if (input.at(-1).type === "function_call_output") {
      const [prefs, review] = input.slice(-2).map((out) => JSON.parse(out.output));
      assert.deepEqual(prefs.preferences, [{ name: "穿衣", value: "怕冷" }]);
      assert.equal(review.moments.records[0].excerpt, "看晚霞");
      assert.equal(review.moments.records[0].id, 1);
      return { output_text: "小确幸 #1 看晚霞" };
    }
    return { output: [{ type: "function_call", call_id: "p", name: "qgent_get_preferences", arguments: '{"name":"穿衣"}' },
      { type: "function_call", call_id: "r", name: "qgent_life_review", arguments: '{"period":"today","kind":"moment"}' }] };
  };
  assert.equal(await ai.chat({ history: [], userId: "alice", prompt: "回顾今天",
    messageTimestamp: "2026-11-02T04:30Z" }), "小确幸 #1 看晚霞");
});
