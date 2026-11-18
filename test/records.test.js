import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RecordTurn } from "../src/records.js";
import { QgentStore } from "../src/storage.js";
import { executeQgentTool, qgentTools } from "../src/tools.js";

function database(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qgent-records-"));
  const store = new QgentStore({ dbPath: path.join(directory, "test.db") });
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return store;
}

function run(store, name, args, { userId = "a", prompt = "", previous, requestId = "m1" } = {}) {
  return executeQgentTool({ store, userId, requestId, recordTurn: new RecordTurn(prompt, previous),
    call: { name, arguments: JSON.stringify(args) } });
}

test("old records keep typed IDs after reopening, and ledger corrections use integer cents in SQL totals", async (t) => {
  const old = database(t);
  old.addNote("a", { content: "发票" });
  old.addLedgerEntry("a", { type: "expense", amount: 28, occurred_on: "2026-09-01", category: "餐饮", note: "午餐" });
  old.addLedgerEntry("b", { type: "expense", amount: 19 });
  old.addMoment("a", { content: "晚霞" });
  old.close();
  const store = new QgentStore({ dbPath: old.dbPath });
  t.after(() => store.close());
  const read = (kind, id = 1, userId = "a") => run(store, "qgent_get_record", { kind, id }, { userId });
  const before = (await read("ledger")).record;
  assert.equal((await read("note")).record.content, "发票");
  assert.equal((await read("moment")).record.content, "晚霞");
  const edit = (args, prompt = "把账目 #1 改一下") => run(store, "qgent_update_ledger", { id: 1, ...args }, { prompt });
  const edited = await edit({ expected_amount: 28, amount: 18.29 });
  assert.deepEqual(edited.record, { ...before, amount: 18.29 });
  assert.equal((await edit({ expected_amount: 28, amount: 18.29 })).duplicate, true);
  await assert.rejects(edit({ expected_amount: 28, amount: 10 }), /原金额/);
  const summary = () => store.ledgerSummary("a", { period: "all" });
  assert.equal(summary().expense, 18.29);
  assert.equal(summary().balance, -18.29);
  await edit({ type: "income", occurred_on: "2026-10-01", category: "报销", note: "" });
  assert.equal(summary().income, 18.29);
  assert.equal(summary().expense, 0);
  assert.equal(store.listLedger("a", { start_date: "2026-10-01", end_date: "2026-10-01" }).entries[0].note, "");
  await assert.rejects(read("ledger", 2), /没有这个编号/);
  await assert.rejects(run(store, "qgent_update_ledger", { id: 2, amount: 9 }, { prompt: "修改账目 #2" }), /没有这个编号/);
  assert.equal(store.ledgerSummary("b", { period: "all" }).expense, 19);
  assert.equal((await read("note")).record.content, "发票");
});

test("edits validate per-kind fields, real dates, cents, appends and total content length before committing", async (t) => {
  const store = database(t);
  store.addNote("a", { title: "待办", content: "去报销", tags: ["工作"] });
  store.addMoment("a", { content: "晚霞", occurred_on: "2026-10-01" });
  store.addLedgerEntry("a", { type: "expense", amount: 28 });
  const edit = (kind, args, prompt) => run(store, "qgent_update_" + kind, { id: 1, ...args }, { prompt });
  for (const [kind, args, prompt] of [
    ["note", {}, "笔记 #1"], ["note", { content: "a", append_content: "b" }, "笔记 #1"],
    ["note", { append_content: " " }, "笔记 #1"], ["note", { append_content: "字".repeat(5000) }, "笔记 #1"],
    ["note", { tags: ["签".repeat(301)] }, "笔记 #1"], ["note", { amount: 18 }, "笔记 #1"],
    ["moment", { occurred_on: "2026-02-30" }, "小确幸 #1"], ["moment", { title: "不支持" }, "小确幸 #1"],
    ["ledger", { amount: 0 }, "账目 #1"], ["ledger", { amount: 18.015 }, "账目 #1"],
    ["ledger", { type: "other" }, "账目 #1"], ["ledger", { expected_amount: 28 }, "账目 #1"],
    ["ledger", { user_id: "b" }, "账目 #1"],
  ]) await assert.rejects(edit(kind, args, prompt));
  assert.deepEqual(store.getWriteReceipts("a"), []);
  const append = () => edit("note", { append_content: "带上发票" }, "那条笔记 #1 加一句");
  await append();
  assert.equal((await append()).duplicate, true);
  const note = (await edit("note", { title: "", tags: [] }, "笔记 #1")).record;
  assert.equal(note.content, "去报销\n带上发票");
  assert.equal(note.title, "");
  assert.equal(note.tags, "");
  const moment = (await edit("moment", { content: "紫色的晚霞", occurred_on: "2026-10-02" }, "小确幸 #1")).record;
  assert.equal(moment.content, "紫色的晚霞");
  assert.equal(moment.occurred_on, "2026-10-02");
  const literal = "发票 '); DROP TABLE notes; --";
  assert.equal((await edit("note", { content: literal }, "笔记 #1")).record.content, literal);
});

test("only a single user-selected typed ID or a unique preceding reference can authorize a target", () => {
  const ledger = { kind: "ledger", id: 8 };
  const note = { kind: "note", id: 8 };
  const other = { kind: "note", id: 9 };
  const allows = (prompt, previous, ref) => new RecordTurn(prompt, previous).allows(ref.kind, ref.id);
  assert.ok(allows("刚才那笔不是 28，是 18", [ledger], ledger));
  assert.ok(allows("那条笔记加一句带上发票", [note], note));
  assert.ok(allows("改笔记 ＃８", [], note));
  assert.ok(allows("#8", [note, other], note));
  assert.equal(allows("那条笔记加一句", [note, other], note), false);
  assert.equal(allows("改笔记 #8 或笔记 #9", [], note), false);
  assert.equal(allows("改笔记 #8", [ledger], ledger), false);
  assert.equal(allows("#8", [ledger, note], note), false);
  assert.equal(allows("改笔记 #8.5", [note], note), false);
  const turn = new RecordTurn("帮我改一个数字");
  turn.observe("qgent_get_record", { kind: "ledger", id: 8 });
  assert.equal(turn.allows("ledger", 8), false);
});

test("preview and committed deletion are owner-scoped, expiring, version-checked and idempotent for every kind", async (t) => {
  const store = database(t);
  for (const [kind, name, label, args] of [
    ["note", "qgent_add_note", "笔记", { content: "旧" }],
    ["ledger", "qgent_add_ledger", "账目", { amount: 20, type: "expense" }],
    ["moment", "qgent_add_moment", "小确幸", { content: "旧" }],
  ]) {
    await run(store, name, args);
    await run(store, name, args, { userId: "b" });
    const argsById = { kind, id: 1 };
    const preview = (userId = "a") => run(store, "qgent_prepare_record_deletion", argsById, { prompt: "删除" + label + " #1", userId });
    await assert.rejects(preview("b"), /没有这个编号/);
    const original = await preview();
    assert.equal(store.getRecord("a", argsById).id, 1);
    const remove = (pending, userId = "a") => store.confirmRecordDeletion(userId, "confirm-" + kind, pending);
    assert.throws(() => remove({ ...original, expiresAt: Date.now() - 1 }), /过期/);
    const expiry = Date.now() + 60_000;
    assert.throws(() => remove({ ...original, expiresAt: expiry }, "b"), /没有这个编号/);
    await run(store, "qgent_update_" + kind, { id: 1, ...(kind === "ledger" ? { amount: 18 } : { content: "新" }) }, { prompt: label + " #1" });
    assert.throws(() => remove({ ...original, expiresAt: expiry }), /预览后已修改/);
    assert.equal(store.getWriteReceipts("a", "confirm-" + kind).length, 0);
    const pending = { ...await preview(), expiresAt: expiry };
    assert.equal(remove(pending).id, 1);
    assert.equal(remove(pending).duplicate, true);
    assert.throws(() => store.getRecord("a", argsById), /没有这个编号/);
    assert.equal(store.getRecord("b", { kind, id: 2 }).id, 2);
  }
  assert.equal(store.ledgerSummary("a", { period: "all" }).count, 0);
  assert.equal(store.ledgerSummary("b", { period: "all" }).expense, 20);
});

test("record tool schemas expose only typed reads, partial edits and a deletion preview", () => {
  for (const name of ["qgent_get_record", "qgent_update_ledger", "qgent_update_note", "qgent_update_moment", "qgent_prepare_record_deletion"]) {
    const { parameters } = qgentTools.find((tool) => tool.name === name);
    assert.equal(parameters.additionalProperties, false);
    assert.equal(parameters.properties.id.minimum, 1);
    assert.ok(parameters.required.includes("id"));
    assert.ok(!Object.hasOwn(parameters.properties, "user_id"));
    assert.ok(!Object.hasOwn(parameters.properties, "record_key"));
  }
  assert.ok(!qgentTools.some((tool) => tool.name === "qgent_delete_record"));
});

test("a SQLite rejection leaves the original record and no edit or delete receipt", async (t) => {
  const store = database(t);
  store.addNote("a", { content: "原文" });
  store.db.exec(`CREATE TRIGGER ignore_update BEFORE UPDATE ON notes BEGIN SELECT RAISE(IGNORE); END;
    CREATE TRIGGER receipt_failure BEFORE INSERT ON tool_receipts BEGIN SELECT RAISE(ABORT, 'test failure'); END;`);
  await assert.rejects(run(store, "qgent_update_note", { id: 1, content: "新内容" }, { prompt: "更正笔记 #1" }), /修改未生效/);
  const args = { kind: "note", id: 1 };
  const pending = { ...store.prepareRecordDeletion("a", args), expiresAt: Date.now() + 60_000 };
  assert.throws(() => store.confirmRecordDeletion("a", "confirm", pending), /test failure/);
  assert.equal(store.getRecord("a", args).record.content, "原文");
  assert.equal(store.getWriteReceipts("a").length, 0);
  store.db.exec("DROP TRIGGER receipt_failure");
  assert.equal(store.confirmRecordDeletion("a", "confirm", pending).success, true);
});
