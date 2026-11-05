import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import assert from "node:assert/strict";
import { ConversationMemory } from "../src/memory.js";
import { QgentStore } from "../src/storage.js";

function createTempDbPath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qgent-storage-test-"));
  return {
    dbPath: path.join(directory, "qgent.db"),
    cleanup: () =>
      fs.rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      }),
  };
}

function createIoFailureFactory(failureStage) {
  let openCount = 0;

  return {
    get openCount() {
      return openCount;
    },
    open(dbPath, options) {
      openCount += 1;
      const database = new DatabaseSync(dbPath, options);
      if (openCount !== 1) return database;

      return {
        get isOpen() {
          return database.isOpen;
        },
        exec(sql, ...args) {
          if (
            failureStage === "migration" &&
            sql.includes("CREATE TABLE IF NOT EXISTS notes")
          ) {
            const error = new Error("disk I/O error");
            error.code = "SQLITE_IOERR_WRITE";
            throw error;
          }
          return database.exec(sql, ...args);
        },
        prepare(sql, ...args) {
          if (
            failureStage === "wal" &&
            sql.trim().toUpperCase() === "PRAGMA JOURNAL_MODE=WAL"
          ) {
            return {
              get() {
                const error = new Error("disk I/O error");
                error.code = "SQLITE_IOERR_WRITE";
                throw error;
              },
            };
          }
          return database.prepare(sql, ...args);
        },
        close: database.close.bind(database),
      };
    },
  };
}

for (const stage of ["wal", "migration"]) {
  test(`fails without journal fallback after ${stage} I/O failure`, (t) => {
    const temporary = createTempDbPath();
    t.after(temporary.cleanup);
    const factory = createIoFailureFactory(stage);
    assert.throws(
      () => new QgentStore({ dbPath: temporary.dbPath, databaseFactory: factory.open }),
      (error) => error.message.includes("SQLite initialization failed") &&
        error.cause?.code === "SQLITE_IOERR_WRITE",
    );
    assert.equal(factory.openCount, 1);
    // A failed initialization releases its connection; a normal startup can recover.
    const store = new QgentStore({ dbPath: temporary.dbPath });
    assert.equal(store.journalMode, "wal");
    store.close();
  });
}

test("persists records and keeps users isolated", (t) => {
  const temporary = createTempDbPath();

  const firstStore = new QgentStore({ dbPath: temporary.dbPath });
  firstStore.addNote("user-1", { content: "private note" });
  assert.equal(firstStore.searchNotes("user-2").count, 0);
  firstStore.addLedgerEntry("user-1", { type: "expense", amount: 12.34 });
  firstStore.addMoment("user-1", { content: "a good day" });
  assert.equal(firstStore.listLedger("user-2").count, 0);
  assert.equal(firstStore.ledgerSummary("user-2").count, 0);
  assert.equal(firstStore.listMoments("user-2").count, 0);
  assert.equal(firstStore.searchNotes("user-2", { query: "' OR 1=1 --" }).count, 0);
  const memory = new ConversationMemory({ maxTurns: 8, ttlMs: 60_000 });
  memory.appendTurn("user-1", "hello", "hi");
  memory.clear("user-1");
  assert.equal(firstStore.searchNotes("user-1").count, 1);
  firstStore.close();

  const secondStore = new QgentStore({ dbPath: temporary.dbPath });
  t.after(() => {
    secondStore.close();
    temporary.cleanup();
  });

  const result = secondStore.searchNotes("user-1");
  assert.equal(secondStore.journalMode, "wal");
  assert.equal(secondStore.ledgerSummary("user-1").expense, 12.34);
  assert.equal(secondStore.listLedger("user-1").count, 1);
  assert.equal(secondStore.listMoments("user-1").count, 1);
  assert.equal(result.count, 1);
  assert.equal(result.notes[0].content, "private note");
});
