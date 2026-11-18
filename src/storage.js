import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ReminderInputError, reminderLocalTime, reminderTimestamp } from "./reminders.js";

const DATABASE_TIMEOUT_MS = 5000;

function openDatabase(dbPath, options) {
  return new DatabaseSync(dbPath, options);
}

function journalModeFromRow(row) {
  return String(row?.journal_mode ?? "").trim().toLowerCase();
}

function journalModeMismatch(requested, actual) {
  const error = new Error(
    `SQLite requested journal_mode=${requested.toLowerCase()}, got ${actual || "unknown"}`,
  );
  error.code = "SQLITE_IOERR_JOURNAL_MODE";
  return error;
}

function storageInitializationError(dbPath, error) {
  return new Error(
    `SQLite initialization failed for ${dbPath}: ${error?.message ?? error}`,
    { cause: error },
  );
}

function localDateParts(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

function dateString(year, month, day) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function todayIn(timeZone) {
  const { year, month, day } = localDateParts(timeZone);
  return dateString(year, month, day);
}

function monthRange(timeZone, offset = 0) {
  const { year, month } = localDateParts(timeZone);
  const anchor = new Date(Date.UTC(year, month - 1 + offset, 1));
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth() + 1;
  const endAnchor = new Date(Date.UTC(y, m, 0));
  return {
    start: dateString(y, m, 1),
    end: dateString(y, m, endAnchor.getUTCDate()),
  };
}

function assertDate(value, field) {
  if (value == null || value === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${field} must be YYYY-MM-DD`);
  }
  return value;
}

function clampLimit(value, fallback = 10, max = 30) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) {
    return tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 10).join(",");
  }
  if (typeof tags === "string") return tags.trim();
  return "";
}

export class QgentStore {
  constructor({ dbPath, timeZone = "Asia/Shanghai", databaseFactory = openDatabase }) {
    this.dbPath = path.resolve(dbPath);
    this.timeZone = timeZone;
    this.databaseFactory = databaseFactory;
    this.db = null;
    this.journalMode = null;

    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.#initialize();
  }

  #initialize() {
    try {
      this.db = this.databaseFactory(this.dbPath, { timeout: DATABASE_TIMEOUT_MS });
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");

      const row = this.db.prepare("PRAGMA journal_mode=WAL").get();
      const actualMode = journalModeFromRow(row);
      if (actualMode !== "wal") {
        throw journalModeMismatch("WAL", actualMode);
      }

      this.#migrate();
      this.journalMode = actualMode;
      console.log(`[storage] journal_mode=${actualMode}`);
    } catch (error) {
      this.#closeDatabase();
      throw storageInitializationError(this.dbPath, error);
    }
  }

  #closeDatabase() {
    try {
      if (this.db?.isOpen) this.db.close();
    } finally {
      this.db = null;
    }
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_receipts (
        user_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        operation_key TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, request_id, operation_key)
      );
      CREATE TABLE IF NOT EXISTS message_results (
        user_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        answer TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS idx_message_results_created ON message_results(created_at);
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_notes_user_created
        ON notes(user_id, id DESC);

      CREATE TABLE IF NOT EXISTS ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        entry_type TEXT NOT NULL CHECK(entry_type IN ('expense', 'income')),
        amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
        currency TEXT NOT NULL DEFAULT 'CNY',
        category TEXT NOT NULL DEFAULT '其他',
        note TEXT NOT NULL DEFAULT '',
        occurred_on TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ledger_user_date
        ON ledger(user_id, occurred_on DESC, id DESC);

      CREATE TABLE IF NOT EXISTS moments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        occurred_on TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_moments_user_date
        ON moments(user_id, occurred_on DESC, id DESC);

      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('c2c', 'group')),
        target_id TEXT NOT NULL CHECK (length(target_id) > 0),
        content TEXT NOT NULL,
        trigger_at INTEGER NOT NULL,
        timezone TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','sending','sent','cancelled','expired','failed','unknown')),
        created_at TEXT NOT NULL,
        next_attempt_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_attempt_at INTEGER,
        qq_message_id TEXT,
        detail TEXT,
        CHECK (scope <> 'c2c' OR target_id = user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_reminders_owner ON reminders(user_id, scope, target_id);
      CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_reminders_attempts ON reminders(scope, target_id, last_attempt_at);
    `);
  }

  executeWriteOnce(userId, requestId, toolName, args, execute) {
    const canonical = JSON.stringify(Object.fromEntries(Object.keys(args).sort().map((key) => [key, args[key]])));
    const operationKey = createHash("sha256").update(`${toolName}:${canonical}`).digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db.prepare(`SELECT result FROM tool_receipts
        WHERE user_id = ? AND request_id = ? AND operation_key = ?`).get(userId, requestId, operationKey);
      if (previous) {
        this.db.exec("COMMIT");
        return { ...JSON.parse(previous.result), duplicate: true };
      }
      const result = execute();
      if (result?.success !== true) throw new Error("写入未成功");
      this.db.prepare(`INSERT INTO tool_receipts
        (user_id, request_id, operation_key, tool_name, result, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(userId, requestId, operationKey, toolName, JSON.stringify(result), this.nowIso());
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getWriteReceipts(userId, requestId, conversationKey) {
    const prefix = conversationKey ? `${conversationKey}:message:` : null;
    const rows = requestId
      ? this.db.prepare(`SELECT tool_name, result FROM tool_receipts WHERE user_id = ? AND request_id = ? ORDER BY rowid`).all(userId, requestId)
      : this.db.prepare(`SELECT tool_name, result FROM tool_receipts WHERE user_id = ?
          AND (? IS NULL OR tool_name NOT IN ('qgent_create_reminder', 'qgent_cancel_reminder') OR instr(request_id, ?) = 1)
          ORDER BY rowid DESC LIMIT 10`).all(userId, prefix, prefix);
    return rows.map((row) => ({ name: row.tool_name, ...JSON.parse(row.result) }));
  }

  getMessageResult(userId, requestId) {
    return this.db.prepare("SELECT answer FROM message_results WHERE user_id = ? AND request_id = ?").get(userId, requestId)?.answer;
  }

  saveMessageResult(userId, requestId, answer) {
    const expiresBefore = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare("DELETE FROM message_results WHERE created_at < ?").run(expiresBefore);
    this.db.prepare(`INSERT OR IGNORE INTO message_results (user_id, request_id, answer, created_at)
      VALUES (?, ?, ?, ?)`).run(userId, requestId, answer, this.nowIso());
  }

  nowIso() {
    return new Date().toISOString();
  }

  today() {
    return todayIn(this.timeZone);
  }

  addNote(userId, { title = "", content, tags = [] }) {
    const cleanContent = String(content ?? "").trim();
    if (!cleanContent) throw new Error("笔记内容不能为空");

    const result = this.db.prepare(`
      INSERT INTO notes (user_id, title, content, tags, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      userId,
      String(title ?? "").trim().slice(0, 120),
      cleanContent.slice(0, 5000),
      normalizeTags(tags).slice(0, 300),
      this.nowIso(),
    );

    return {
      success: true,
      id: Number(result.lastInsertRowid),
      title: String(title ?? "").trim(),
      content: cleanContent,
    };
  }

  searchNotes(userId, { query = "", limit = 10 } = {}) {
    const cleanQuery = String(query ?? "").trim();
    const safeLimit = clampLimit(limit);
    let rows;

    if (cleanQuery) {
      const like = `%${cleanQuery}%`;
      rows = this.db.prepare(`
        SELECT id, title, content, tags, created_at
        FROM notes
        WHERE user_id = ?
          AND (title LIKE ? OR content LIKE ? OR tags LIKE ?)
        ORDER BY id DESC
        LIMIT ?
      `).all(userId, like, like, like, safeLimit);
    } else {
      rows = this.db.prepare(`
        SELECT id, title, content, tags, created_at
        FROM notes
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT ?
      `).all(userId, safeLimit);
    }

    return { success: true, count: rows.length, notes: rows };
  }

  addLedgerEntry(userId, {
    type,
    amount,
    category = "其他",
    note = "",
    occurred_on: occurredOn,
  }) {
    const entryType = type === "income" ? "income" : type === "expense" ? "expense" : null;
    if (!entryType) throw new Error("type 必须是 expense 或 income");

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      throw new Error("金额必须是大于 0 的数字");
    }

    const amountMinor = Math.round(numericAmount * 100);
    const date = assertDate(occurredOn, "occurred_on") || this.today();
    const cleanCategory = String(category ?? "其他").trim() || "其他";
    const cleanNote = String(note ?? "").trim();

    const result = this.db.prepare(`
      INSERT INTO ledger
        (user_id, entry_type, amount_minor, currency, category, note, occurred_on, created_at)
      VALUES (?, ?, ?, 'CNY', ?, ?, ?, ?)
    `).run(
      userId,
      entryType,
      amountMinor,
      cleanCategory.slice(0, 80),
      cleanNote.slice(0, 500),
      date,
      this.nowIso(),
    );

    return {
      success: true,
      id: Number(result.lastInsertRowid),
      type: entryType,
      amount: amountMinor / 100,
      currency: "CNY",
      category: cleanCategory,
      note: cleanNote,
      occurred_on: date,
    };
  }

  #resolveLedgerRange({ period = "this_month", start_date: startDate, end_date: endDate } = {}) {
    const start = assertDate(startDate, "start_date");
    const end = assertDate(endDate, "end_date");
    if (start || end) {
      return { start: start || "0000-01-01", end: end || "9999-12-31", label: "custom" };
    }

    if (period === "today") {
      const today = this.today();
      return { start: today, end: today, label: "today" };
    }
    if (period === "last_month") {
      return { ...monthRange(this.timeZone, -1), label: "last_month" };
    }
    if (period === "all") {
      return { start: "0000-01-01", end: "9999-12-31", label: "all" };
    }
    return { ...monthRange(this.timeZone, 0), label: "this_month" };
  }

  ledgerSummary(userId, options = {}) {
    const range = this.#resolveLedgerRange(options);
    const category = String(options.category ?? "").trim();
    const params = [userId, range.start, range.end];
    let categorySql = "";
    if (category) {
      categorySql = " AND category = ?";
      params.push(category);
    }

    const totals = this.db.prepare(`
      SELECT entry_type, COALESCE(SUM(amount_minor), 0) AS total_minor, COUNT(*) AS count
      FROM ledger
      WHERE user_id = ? AND occurred_on BETWEEN ? AND ?${categorySql}
      GROUP BY entry_type
    `).all(...params);

    let incomeMinor = 0;
    let expenseMinor = 0;
    let count = 0;
    for (const row of totals) {
      count += Number(row.count || 0);
      if (row.entry_type === "income") incomeMinor = Number(row.total_minor || 0);
      if (row.entry_type === "expense") expenseMinor = Number(row.total_minor || 0);
    }

    const topCategories = this.db.prepare(`
      SELECT category, COALESCE(SUM(amount_minor), 0) AS total_minor, COUNT(*) AS count
      FROM ledger
      WHERE user_id = ? AND entry_type = 'expense'
        AND occurred_on BETWEEN ? AND ?${categorySql}
      GROUP BY category
      ORDER BY total_minor DESC
      LIMIT 8
    `).all(...params).map((row) => ({
      category: row.category,
      amount: Number(row.total_minor || 0) / 100,
      count: Number(row.count || 0),
    }));

    return {
      success: true,
      period: range.label,
      start_date: range.start,
      end_date: range.end,
      category: category || null,
      income: incomeMinor / 100,
      expense: expenseMinor / 100,
      balance: (incomeMinor - expenseMinor) / 100,
      count,
      currency: "CNY",
      top_expense_categories: topCategories,
    };
  }

  listLedger(userId, options = {}) {
    const range = this.#resolveLedgerRange(options);
    const safeLimit = clampLimit(options.limit, 10, 30);
    const rows = this.db.prepare(`
      SELECT id, entry_type AS type, amount_minor, currency, category, note, occurred_on, created_at
      FROM ledger
      WHERE user_id = ? AND occurred_on BETWEEN ? AND ?
      ORDER BY occurred_on DESC, id DESC
      LIMIT ?
    `).all(userId, range.start, range.end, safeLimit).map((row) => ({
      ...row,
      amount: Number(row.amount_minor) / 100,
      amount_minor: undefined,
    }));

    return {
      success: true,
      start_date: range.start,
      end_date: range.end,
      count: rows.length,
      entries: rows,
    };
  }

  addMoment(userId, { content, occurred_on: occurredOn }) {
    const cleanContent = String(content ?? "").trim();
    if (!cleanContent) throw new Error("小确幸内容不能为空");
    const date = assertDate(occurredOn, "occurred_on") || this.today();

    const result = this.db.prepare(`
      INSERT INTO moments (user_id, content, occurred_on, created_at)
      VALUES (?, ?, ?, ?)
    `).run(userId, cleanContent.slice(0, 3000), date, this.nowIso());

    return {
      success: true,
      id: Number(result.lastInsertRowid),
      content: cleanContent,
      occurred_on: date,
    };
  }

  listMoments(userId, { limit = 10 } = {}) {
    const safeLimit = clampLimit(limit, 10, 30);
    const rows = this.db.prepare(`
      SELECT id, content, occurred_on, created_at
      FROM moments
      WHERE user_id = ?
      ORDER BY occurred_on DESC, id DESC
      LIMIT ?
    `).all(userId, safeLimit);

    return { success: true, count: rows.length, moments: rows };
  }

  addReminder(userId, { content, trigger_at, timezone = this.timeZone }, target) {
    const text = content.trim();
    if (!text || text.length > 500) throw new ReminderInputError("提醒内容应为 1 至 500 个字符。");
    const triggerAt = reminderTimestamp(trigger_at, timezone, Date.now());
    const result = this.db.prepare(`
      INSERT INTO reminders (user_id, scope, target_id, content, trigger_at, timezone, created_at, next_attempt_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, target.scope, target.targetId, text, triggerAt, timezone, this.nowIso(), triggerAt);
    return {
      success: true, id: Number(result.lastInsertRowid), status: "pending", scope: target.scope,
      content: text, trigger_at: new Date(triggerAt).toISOString(), local_time: reminderLocalTime(triggerAt, timezone), timezone,
    };
  }

  listReminders(userId, { id = null, status = null, limit = 10 }, target) {
    const reminders = this.db.prepare(`
      SELECT id, content, trigger_at, timezone, status, detail FROM reminders
      WHERE user_id = ? AND scope = ? AND target_id = ?
        AND (? IS NULL OR id = ?) AND (? IS NULL OR status = ?)
      ORDER BY CASE WHEN status = 'pending' THEN trigger_at END ASC NULLS LAST, trigger_at DESC, id DESC
      LIMIT ?
    `).all(userId, target.scope, target.targetId, id, id, status, status, clampLimit(limit)).map((row) => ({
      ...row, trigger_at: new Date(row.trigger_at).toISOString(), local_time: reminderLocalTime(row.trigger_at, row.timezone),
    }));
    return { success: true, count: reminders.length, reminders };
  }

  cancelReminder(userId, { id }, target) {
    const result = this.db.prepare(`UPDATE reminders SET status = 'cancelled', detail = NULL
      WHERE user_id = ? AND scope = ? AND target_id = ? AND id = ? AND status = 'pending'`)
      .run(userId, target.scope, target.targetId, id);
    if (!result.changes) throw new ReminderInputError("当前会话没有这条可取消的待发送提醒，请先查询状态。");
    return { success: true, id, status: "cancelled" };
  }

  // Only the scheduler can claim across owners. A single UPDATE arbitrates
  // between a due send, a concurrent scan and an owner's cancellation.
  claimDueReminder(now, oldestDue, staleSend) {
    this.db.prepare(`UPDATE reminders SET status = 'expired', detail = '已超过补发期限'
      WHERE status = 'pending' AND next_attempt_at <= ? AND trigger_at < ?`).run(now, oldestDue);
    this.db.prepare(`UPDATE reminders SET status = 'unknown', detail = '发送中断，未能确认 QQ 回执'
      WHERE status = 'sending' AND last_attempt_at <= ?`).run(staleSend);
    // Count attempts conservatively over a rolling 24 hours, shared by all
    // owners in a group. A saturated target must not block other recipients.
    return this.db.prepare(`
      UPDATE reminders SET status = 'sending', last_attempt_at = ?, attempts = attempts + 1, detail = NULL
      WHERE id = (
        SELECT r.id FROM reminders r WHERE r.status = 'pending' AND r.next_attempt_at <= ?
        AND (SELECT COALESCE(SUM(h.attempts), 0) FROM reminders h
             WHERE h.scope = r.scope AND h.target_id = r.target_id AND h.last_attempt_at > ?) < 1000
        ORDER BY r.next_attempt_at, r.id LIMIT 1
      ) AND status = 'pending'
      RETURNING id, scope, target_id, content, attempts
    `).get(now, now, now - 24 * 60 * 60_000);
  }

  finishReminder(id, { status, detail = null, messageId = null, retryAt = null }) {
    const result = this.db.prepare(`UPDATE reminders SET status = ?, detail = ?, qq_message_id = ?,
      next_attempt_at = COALESCE(?, next_attempt_at)
      WHERE id = ? AND status = 'sending'`).run(status, detail, messageId, retryAt, id);
    if (!result.changes) throw new Error("提醒的发送状态已变更，未写入本次结果");
  }

  close() {
    this.#closeDatabase();
  }
}

// Maintenance uses independent connections, never QgentStore initialization/migrations.
// VACUUM INTO creates a consistent SQLite snapshot, including committed WAL pages.
function openSnapshotSource(sourcePath) {
  const filename = path.resolve(sourcePath);
  if (!fs.statSync(filename).isFile()) throw new Error("数据库源路径必须是已有文件");
  const database = new DatabaseSync(filename, { readOnly: true, timeout: DATABASE_TIMEOUT_MS });
  try {
    database.exec("PRAGMA busy_timeout=5000");
    return database;
  } catch (error) { database.close(); throw error; }
}

function checkSnapshot(database) {
  const checks = database.prepare("PRAGMA integrity_check").all();
  if (!checks.length || checks.some((row) => row.integrity_check !== "ok")) {
    throw new Error("SQLite 完整性校验失败");
  }
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  for (const name of ["notes", "ledger", "moments"]) {
    if (!tables.has(name)) throw new Error(`不是可识别的 Qgent 数据库，缺少表 ${name}`);
  }
  if (database.prepare("PRAGMA foreign_key_check").all().length) throw new Error("SQLite 外键校验失败");
}

export function verifyDatabaseSnapshot(sourcePath) {
  const database = openSnapshotSource(sourcePath);
  try {
    checkSnapshot(database);
    return { path: path.resolve(sourcePath), integrity: "ok" };
  } finally { database.close(); }
}

function assertUnusedDestination(filename) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    // lstat also refuses dangling symlinks instead of following/replacing them.
    try { fs.lstatSync(filename + suffix); } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error(`目标或 SQLite 辅助文件已存在，拒绝覆盖: ${filename + suffix}`);
  }
}

export function createDatabaseSnapshot({ sourcePath, destinationPath }) {
  const destination = path.resolve(destinationPath);
  assertUnusedDestination(destination);
  const source = openSnapshotSource(sourcePath);
  let stagingDirectory;
  try {
    checkSnapshot(source);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    stagingDirectory = fs.mkdtempSync(path.join(path.dirname(destination), ".qgent-snapshot-"));
    fs.chmodSync(stagingDirectory, 0o700);
    const stagingFile = path.join(stagingDirectory, "snapshot.db");
    source.prepare("VACUUM INTO ?").run(stagingFile);
    fs.chmodSync(stagingFile, 0o600);
    const snapshot = new DatabaseSync(stagingFile);
    try {
      // Publish one self-contained file, independent of WAL/SHM sidecars.
      const mode = snapshot.prepare("PRAGMA journal_mode=DELETE").get();
      if (mode.journal_mode !== "delete") throw new Error("无法生成独立的 SQLite 快照文件");
      checkSnapshot(snapshot);
    } finally { snapshot.close(); }
    const descriptor = fs.openSync(stagingFile, "r");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    assertUnusedDestination(destination);
    // Same-filesystem hard link publishes atomically and never replaces an existing file.
    fs.linkSync(stagingFile, destination);
    const directoryDescriptor = fs.openSync(path.dirname(destination), "r");
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
    return { path: destination, integrity: "ok", bytes: fs.statSync(destination).size };
  } finally {
    source.close();
    if (stagingDirectory) fs.rmSync(stagingDirectory, { recursive: true, force: true });
  }
}
