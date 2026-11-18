import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { QgentStore } from "../src/storage.js";
import { checkDueWeather, nextWeatherCheck } from "../src/weather-subscriptions.js";
import { dispatchDueReminder } from "../src/reminders.js";
import { executeQgentTool } from "../src/tools.js";
import { WeatherClient } from "../src/weather.js";

const due = Date.parse("2026-11-18T00:00Z");
const target = { scope: "c2c", targetId: "alice" };
const basic = { city: "杭州", temperature: 18, weather: "多云", report_time: "2026-11-18 07:45:00" };
function database(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qgent-weather-sub-"));
  const store = new QgentStore({ dbPath: path.join(dir, "test.db") });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return store;
}
function subscribe(store, now = due - 1000, check_time = "08:00") {
  return store.subscribeWeather("alice", { city: "杭州市", check_time }, now);
}
const weatherClient = (data) => new WeatherClient({ apiKey: "test", fetchImpl: async () => Response.json(data) });
const tick = (store, weather, time = due) => checkDueWeather({ store, weather, now: () => time });

test("interactive weather uses explicit, personal, then configured location and keeps dated advice separate", async (t) => {
  const store = database(t);
  store.setPreference("alice", "城市", "杭州");
  store.setPreference("bob", "城市", "苏州");
  const weather = weatherClient({ ...basic, feels_like: 0, precipitation: 0,
    forecast: [{ date: "2026-11-19", precip: 2, temp_max: 18, temp_min: 7 }] });
  const run = (args, userId = "alice", defaultLocation = "上海") => executeQgentTool({ store, weather, userId,
    defaultLocation, call: { name: "qgent_get_weather", arguments: JSON.stringify(args) } });
  assert.equal((await run({ city: "北京" })).requested_city, "北京");
  const result = await run({});
  assert.equal(result.requested_city, "杭州");
  assert.match(result.guidance.current.join(""), /体感 0℃/);
  assert.doesNotMatch(result.guidance.current.join(""), /降水|明天/);
  assert.equal(result.guidance.forecast[0].date, "2026-11-19");
  assert.match(result.guidance.forecast[0].tips.join(""), /2 毫米.*分层/u);
  assert.equal((await run({}, "bob")).requested_city, "苏州");
  assert.equal((await run({}, "other")).requested_city, "上海");
  await assert.rejects(run({}, "other", ""), /城市/);
});

test("a qualifying check creates one durable, rate-limited reminder for the subscribing C2C user", async (t) => {
  const store = database(t);
  const weather = weatherClient({ ...basic, forecast: [{ date: "2026-11-18", temp_min: 6, temp_max: 18, precip: 2 }] });
  await tick(store, { getWeather: () => assert.fail("no subscription") });
  assert.equal(subscribe(store).next_check_at, due);
  await tick(store, weather, due - 1);
  await Promise.all([tick(store, weather), tick(store, weather)]);
  const sub = store.getWeatherSubscription("alice");
  assert.equal(sub.last_result, "queued");
  assert.equal(sub.delivery, "pending");
  assert.equal(store.listReminders("alice", {}, target).count, 1);
  store.close();
  const reopened = new QgentStore({ dbPath: store.dbPath });
  t.after(() => reopened.close());
  const sent = [];
  const send = async (to, content) => { sent.push({ to, content }); return { id: "qq-ack" }; };
  await tick(reopened, { getWeather: () => assert.fail("already checked") });
  await dispatchDueReminder({ store: reopened, now: () => due, send });
  await dispatchDueReminder({ store: reopened, now: () => due, send });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, target);
  assert.match(sent[0].content, /杭州.*天气提醒/s);
  assert.match(sent[0].content, /2 毫米.*6～18℃.*UAPI/s);
  assert.equal(reopened.getWeatherSubscription("alice").delivery, "sent");
});

test("missing, stale, mismatched and non-triggering data produce no weather push", async (t) => {
  for (const [label, data, status] of [
    ["basic", basic, "no_match"],
    ["no numeric evidence", { ...basic, weather: "大雨", precipitation: "9", feels_like: null }, "no_match"],
    ["another date", { ...basic, forecast: [{ date: "2026-11-19", precip: 5 }] }, "no_match"],
    ["city mismatch", { ...basic, city: "苏州", temperature: 0 }, "location_mismatch"],
    ["stale", { ...basic, temperature: 0, report_time: "2026-11-17 20:00:00" }, "stale_report"],
    ["future", { ...basic, temperature: 0, report_time: "2026-11-18T08:00:00Z" }, "stale_report"],
    ["bad timestamp", { ...basic, temperature: 0, report_time: "未知" }, "stale_report"],
    ["lookup failure", {}, "lookup_failed"],
  ]) {
    await t.test(label, async (t) => {
      const store = database(t);
      subscribe(store);
      await tick(store, weatherClient(data));
      assert.equal(store.getWeatherSubscription("alice").last_result, status);
      assert.equal(store.listReminders("alice", {}, target).count, 0);
      await tick(store, { getWeather: () => assert.fail("no repeated lookups") });
    });
  }
});

test("changes or cancellation during lookup discard its result, and cancellation removes a queued send", async (t) => {
  for (const action of ["change", "cancel", "queued"]) {
    await t.test(action, async (t) => {
      const store = database(t);
      subscribe(store);
      let finish;
      const lookup = tick(store, { getWeather: () => new Promise((resolve) => { finish = resolve; }) });
      if (action === "change") subscribe(store, due + 1000, "09:00");
      if (action === "cancel") store.cancelWeatherSubscription("alice");
      finish({ success: true, weather: { ...basic, temperature: 0 } });
      await lookup;
      if (action === "queued") {
        assert.equal(store.getWeatherSubscription("alice").delivery, "pending");
        assert.throws(() => store.cancelWeatherSubscription("bob"), /没有/);
        store.cancelWeatherSubscription("alice");
      }
      await dispatchDueReminder({ store, now: () => due, send: () => assert.fail("cancelled or superseded") });
      assert.equal(store.listReminders("alice", { status: "pending" }, target).count, 0);
      assert.equal(subscribe(store, due + 1000, "10:00").next_check_at, Date.parse("2026-11-19T02:00Z"));
    });
  }
});

test("a crash after reservation or a long outage does not replay a missed weather alert", async (t) => {
  const store = database(t);
  subscribe(store);
  const claim = store.claimWeatherCheck(due);
  assert.ok(claim);
  assert.equal(store.claimWeatherCheck(due), undefined);
  store.close();
  const reopened = new QgentStore({ dbPath: store.dbPath });
  t.after(() => reopened.close());
  const unused = { getWeather: () => assert.fail("late or duplicate lookup") };
  await tick(reopened, unused);
  await tick(reopened, unused, due + 26 * 3_600_000);
  assert.equal(reopened.getWeatherSubscription("alice").last_result, "missed");
  assert.equal(reopened.finishWeatherCheck(claim, { status: "queued", content: "old" }, due), false);
  assert.equal(reopened.listReminders("alice", {}, target).count, 0);
});

test("after several days offline, the current day's check can still run inside its window", async (t) => {
  const store = database(t);
  subscribe(store);
  const restarted = Date.parse("2026-11-21T00:10Z");
  await tick(store, weatherClient({ ...basic, temperature: 4, report_time: "2026-11-21T00:00:00Z" }), restarted);
  const sub = store.getWeatherSubscription("alice");
  assert.equal(sub.last_result, "queued");
  assert.equal(sub.next_check_at, Date.parse("2026-11-22T00:00Z"));
  assert.equal(store.listReminders("alice", {}, target).count, 1);
});

test("an in-flight weather send records a late acceptance but cannot retry after unsubscribe", async (t) => {
  for (const accepted of [false, true]) {
    const store = database(t);
    subscribe(store);
    await tick(store, weatherClient({ ...basic, temperature: 3 }));
    const id = store.getWeatherSubscription("alice").reminder_id;
    let finish;
    const sending = dispatchDueReminder({ store, now: () => due,
      send: () => new Promise((resolve) => { finish = resolve; }) });
    store.cancelWeatherSubscription("alice");
    finish(accepted ? { id: "accepted" } : { code: 40034100 });
    await sending;
    assert.equal(store.listReminders("alice", { id }, target).reminders[0].status, accepted ? "sent" : "cancelled");
    await dispatchDueReminder({ store, now: () => due + 60_000, send: () => assert.fail("revoked retry") });
  }
});

test("subscription schedule skips ambiguous/nonexistent wall-clock times and enforces a minimum interval", () => {
  const next = (date, time, last) => new Date(nextWeatherCheck(Date.parse(date), "America/New_York", time, last)).toISOString();
  assert.equal(next("2026-03-08T05:01Z", "02:30"), "2026-03-09T06:30:00.000Z");
  assert.equal(next("2026-11-01T04:01Z", "01:30"), "2026-11-02T06:30:00.000Z");
  assert.equal(next("2026-11-02T04:51Z", "00:05", Date.parse("2026-11-02T04:50Z")), "2026-11-03T05:05:00.000Z");
  assert.throws(() => next("2026-11-01T04:01Z", "24:01"), /HH:mm/);
});
