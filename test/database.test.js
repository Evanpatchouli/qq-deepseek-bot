import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { QgentStore, createDatabaseSnapshot, verifyDatabaseSnapshot } from "../src/storage.js";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qgent-snapshot-test-"));
  const sourcePath = path.join(directory, "source.db");
  const store = new QgentStore({ dbPath: sourcePath });
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, sourcePath, store, output: path.join(directory, "backup.db") };
}

function cli(...args) {
  return spawnSync(process.execPath, ["scripts/database.js", ...args], {
    encoding: "utf8", env: { PATH: process.env.PATH },
  });
}

test("online snapshot includes committed WAL data, excludes uncommitted writes, restores all users", (t) => {
  const { store, sourcePath, directory, output } = fixture(t);
  store.db.exec("PRAGMA wal_autocheckpoint=0");
  const result = store.executeWriteOnce("alice", "message1", "qgent_add_note", { content: "私人笔记" },
    () => store.addNote("alice", { content: "私人笔记" }));
  store.saveMessageResult("alice", "message1", "已保存");
  store.addNote("bob", { content: "另一个用户" });
  store.addLedgerEntry("alice", { type: "expense", amount: 12.34 });
  store.addLedgerEntry("bob", { type: "income", amount: 100 });
  store.addMoment("alice", { content: "开心" });
  assert.ok(fs.statSync(`${sourcePath}-wal`).size > 0);
  store.db.exec("BEGIN IMMEDIATE");
  store.addNote("alice", { content: "尚未提交" });
  try {
    assert.equal(createDatabaseSnapshot({ sourcePath, destinationPath: output }).integrity, "ok");
  } finally { store.db.exec("ROLLBACK"); }
  assert.equal(fs.existsSync(`${output}-wal`), false);
  assert.equal(fs.existsSync(`${output}-shm`), false);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  const destinationPath = path.join(directory, "restored", "qgent.db");
  createDatabaseSnapshot({ sourcePath: output, destinationPath });
  const recovered = new QgentStore({ dbPath: destinationPath });
  try {
    assert.equal(recovered.searchNotes("alice").count, 1);
    assert.equal(recovered.searchNotes("bob").count, 1);
    assert.equal(recovered.searchNotes("other").count, 0);
    assert.equal(recovered.ledgerSummary("alice").expense, 12.34);
    assert.equal(recovered.ledgerSummary("bob").income, 100);
    assert.equal(recovered.listMoments("alice").count, 1);
    assert.equal(recovered.listMoments("bob").count, 0);
    assert.equal(recovered.searchNotes("other", { query: "' OR 1=1 --" }).count, 0);
    assert.equal(recovered.getWriteReceipts("alice", "message1")[0].id, result.id);
    assert.equal(recovered.getWriteReceipts("bob", "message1").length, 0);
    assert.equal(recovered.getMessageResult("alice", "message1"), "已保存");
    recovered.addNote("alice", { content: "恢复后仍能写入" });
  } finally { recovered.close(); }
  const reopened = new QgentStore({ dbPath: destinationPath });
  try { assert.equal(reopened.searchNotes("alice").count, 2); } finally { reopened.close(); }
  assert.equal(store.searchNotes("alice").count, 1);
  assert.equal(verifyDatabaseSnapshot(output).integrity, "ok");
});

test("refuses existing destination, source alias, and SQLite sidecars without modifying them", (t) => {
  const { sourcePath, output, store } = fixture(t);
  store.addNote("alice", { content: "preserved" });
  assert.throws(() => createDatabaseSnapshot({ sourcePath, destinationPath: sourcePath }), /拒绝覆盖/);
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    fs.writeFileSync(output + suffix, "preserve me");
    assert.throws(() => createDatabaseSnapshot({ sourcePath, destinationPath: output }), /拒绝覆盖/);
    assert.equal(fs.readFileSync(output + suffix, "utf8"), "preserve me");
    fs.unlinkSync(output + suffix);
  }
  fs.symlinkSync(path.join(path.dirname(output), "missing.db"), output);
  assert.throws(() => createDatabaseSnapshot({ sourcePath, destinationPath: output }), /拒绝覆盖/);
  assert.equal(store.searchNotes("alice").count, 1);
});

test("rejects missing, corrupt and unrelated databases without publishing output", (t) => {
  const { directory, output } = fixture(t);
  const missing = path.join(directory, "missing.db");
  assert.throws(() => createDatabaseSnapshot({ sourcePath: missing, destinationPath: output }));
  assert.equal(fs.existsSync(missing), false);
  const corrupt = path.join(directory, "corrupt.db");
  fs.writeFileSync(corrupt, "not a SQLite database");
  const unrelated = path.join(directory, "unrelated.db");
  const db = new DatabaseSync(unrelated);
  db.exec("CREATE TABLE other (id INTEGER)");
  db.close();
  for (const sourcePath of [corrupt, unrelated]) {
    assert.throws(() => createDatabaseSnapshot({ sourcePath, destinationPath: output }));
    assert.throws(() => verifyDatabaseSnapshot(sourcePath));
    assert.equal(fs.existsSync(output), false);
  }
  assert.equal(fs.readdirSync(directory).some((name) => name.startsWith(".qgent-snapshot-")), false);
});

test("legacy database without reliability tables remains compatible", (t) => {
  const { store, sourcePath, output } = fixture(t);
  store.db.exec("DROP TABLE tool_receipts; DROP TABLE message_results");
  store.addNote("alice", { content: "legacy" });
  createDatabaseSnapshot({ sourcePath, destinationPath: output });
  const recovered = new QgentStore({ dbPath: output });
  try {
    assert.equal(recovered.searchNotes("alice").notes[0].content, "legacy");
    assert.deepEqual(recovered.getWriteReceipts("alice"), []);
  } finally { recovered.close(); }
});

test("CLI backup, verify and restore work without service credentials", (t) => {
  const { store, sourcePath, directory, output } = fixture(t);
  store.addNote("alice", { content: "CLI private content" });
  for (const args of [
    ["backup", "--source", sourcePath, "--output", output],
    ["verify", "--source", output],
    ["restore", "--source", output, "--output", path.join(directory, "restore.db")],
  ]) {
    const result = cli(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /success=true/);
    assert.equal(result.stdout.includes("CLI private content"), false);
  }
  const duplicate = cli("restore", "--source", output, "--output", sourcePath);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /拒绝覆盖/);
});

test("CLI invalid arguments fail; help does not access database", () => {
  for (const args of [["backup"], ["restore", "--source", "missing"], ["verify", "--source", "missing"],
    ["verify", "--source", "x", "--output", "y"], ["backup", "--unknown"], ["delete"]]) {
    assert.equal(cli(...args).status, 1);
  }
  assert.equal(cli("--help").status, 0);
});

test("publication I/O failure leaves no final file or temporary directory and allows retry", (t) => {
  const { sourcePath, output, store, directory } = fixture(t);
  store.addNote("alice", { content: "survives failed backup" });
  t.mock.method(fs, "linkSync", () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); });
  assert.throws(() => createDatabaseSnapshot({ sourcePath, destinationPath: output }), { code: "ENOSPC" });
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.readdirSync(directory).some((name) => name.startsWith(".qgent-snapshot-")), false);
  assert.equal(store.searchNotes("alice").count, 1);
  t.mock.restoreAll();
  assert.equal(createDatabaseSnapshot({ sourcePath, destinationPath: output }).integrity, "ok");
});

test("automatic backup names use 14 digits and repeated backups preserve earlier files", (t) => {
  const { store, sourcePath, directory } = fixture(t);
  store.addNote("alice", { content: "automatic backup" });
  const paths = [];
  let firstBytes;
  for (let index = 0; index < 3; index++) {
    const result = cli("backup", "--source", sourcePath);
    assert.equal(result.status, 0, result.stderr);
    const metadata = JSON.parse(result.stdout.split("success=true ")[1].trim());
    assert.match(path.basename(metadata.path), /^qgent-\d{14}(?:-\d+)?\.db$/);
    assert.equal(path.dirname(metadata.path), path.join(directory, "backups"));
    assert.equal(verifyDatabaseSnapshot(metadata.path).integrity, "ok");
    paths.push(metadata.path);
    if (!firstBytes) firstBytes = fs.readFileSync(metadata.path);
  }
  assert.equal(new Set(paths).size, 3);
  assert.deepEqual(fs.readFileSync(paths[0]), firstBytes);
});
