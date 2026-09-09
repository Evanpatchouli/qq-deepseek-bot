import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import assert from "node:assert/strict";
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

test("reopens with MEMORY journal after WAL initialization I/O failure", (t) => {
  const temporary = createTempDbPath();

  const factory = createIoFailureFactory("wal");
  const store = new QgentStore({
    dbPath: temporary.dbPath,
    databaseFactory: factory.open,
  });
  t.after(() => {
    store.close();
    temporary.cleanup();
  });

  assert.equal(factory.openCount, 2);
  assert.equal(store.journalMode, "memory");
  assert.equal(
    store.addNote("user-1", { content: "fallback works" }).success,
    true,
  );
});

test("reopens with MEMORY journal after migration I/O failure", (t) => {
  const temporary = createTempDbPath();

  const factory = createIoFailureFactory("migration");
  const store = new QgentStore({
    dbPath: temporary.dbPath,
    databaseFactory: factory.open,
  });
  t.after(() => {
    store.close();
    temporary.cleanup();
  });

  assert.equal(factory.openCount, 2);
  assert.equal(store.journalMode, "memory");
  assert.equal(
    store.addNote("user-1", { content: "migration fallback works" }).success,
    true,
  );
});

test("persists records and keeps users isolated", (t) => {
  const temporary = createTempDbPath();

  const firstStore = new QgentStore({ dbPath: temporary.dbPath });
  firstStore.addNote("user-1", { content: "private note" });
  assert.equal(firstStore.searchNotes("user-2").count, 0);
  firstStore.close();

  const secondStore = new QgentStore({ dbPath: temporary.dbPath });
  t.after(() => {
    secondStore.close();
    temporary.cleanup();
  });

  const result = secondStore.searchNotes("user-1");
  assert.equal(result.count, 1);
  assert.equal(result.notes[0].content, "private note");
});
