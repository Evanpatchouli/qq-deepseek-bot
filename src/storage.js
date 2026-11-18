import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ReminderInputError, reminderLocalTime, reminderTimestamp } from "./reminders.js";
import { RecordInputError } from "./records.js";
import { dateRange, isCalendarDate, localDate, noteTimeBounds } from "./dates.js";
import { checkCity, checkPreference, checkPreferenceName, PreferenceInputError } from "./preferences.js";
import { nextWeatherCheck, weatherCheckWindow } from "./weather-subscriptions.js";

const DATABASE_TIMEOUT_MS = 5000;
// SQL identifiers come exclusively from this allowlist. All record values are bound.
const recordTables = {
  ledger: { table: "ledger", columns: "id, entry_type AS type, amount_minor, currency, category, note, occurred_on, created_at" },
  note: { table: "notes", columns: "id, title, content, tags, created_at" },
  moment: { table: "moments", columns: "id, content, occurred_on, created_at" },
};

function publicRecord(kind, row) {
  if (kind !== "ledger") return row;
  const { amount_minor, ...record } = row;
  return { ...record, amount: amount_minor / 100 };
}

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

function assertDate(value, field) {
  if (value == null || value === "") return null;
  if (!isCalendarDate(value)) {
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
      CREATE INDEX IF NOT EXISTS idx_notes_user_timestamp ON notes(user_id, created_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS user_preferences (
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (user_id, name)
      );

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
      CREATE TABLE IF NOT EXISTS weather_subscriptions (
        user_id TEXT PRIMARY KEY NOT NULL,
        city TEXT NOT NULL,
        timezone TEXT NOT NULL,
        check_time TEXT NOT NULL,
        next_check_at INTEGER,
        last_check_at INTEGER,
        last_result TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        reminder_id INTEGER REFERENCES reminders(id)
      );
      CREATE INDEX IF NOT EXISTS idx_weather_due ON weather_subscriptions(next_check_at) WHERE next_check_at IS NOT NULL;
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
          AND (? IS NULL OR tool_name NOT IN ('qgent_create_reminder', 'qgent_cancel_reminder', 'qgent_set_preference',
              'qgent_delete_preference', 'qgent_subscribe_weather', 'qgent_cancel_weather_subscription') OR instr(request_id, ?) = 1)
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

  listPreferences(userId, { name } = {}) {
    const preferences = name === undefined
      ? this.db.prepare("SELECT name, value FROM user_preferences WHERE user_id = ? ORDER BY name").all(userId)
      : this.db.prepare("SELECT name, value FROM user_preferences WHERE user_id = ? AND name = ?").all(userId, checkPreferenceName(name));
    return { success: true, preferences };
  }

  preferenceValue(userId, name) {
    return this.db.prepare("SELECT value FROM user_preferences WHERE user_id = ? AND name = ?").get(userId, name)?.value;
  }

  userTimeZone(userId) {
    return this.preferenceValue(userId, "时区") ?? this.timeZone;
  }

  setPreference(userId, name, value) {
    const clean = checkPreference(name, value);
    const result = this.db.prepare(`INSERT INTO user_preferences (user_id, name, value)
      SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM user_preferences WHERE user_id = ? AND name = ?)
        OR (SELECT COUNT(*) FROM user_preferences WHERE user_id = ?) < 12
      ON CONFLICT(user_id, name) DO UPDATE SET value = excluded.value`).run(userId, name, clean, userId, name, userId);
    if (result.changes !== 1) throw new PreferenceInputError("最多保存 12 项长期偏好，请先删除一项。");
    return { success: true, preference: name };
  }

  deletePreference(userId, name) {
    const result = this.db.prepare("DELETE FROM user_preferences WHERE user_id = ? AND name = ?").run(userId, checkPreferenceName(name));
    if (!result.changes) throw new PreferenceInputError("没有找到你的这项长期偏好。");
    return { success: true, preference: name };
  }

  today(userId, now) {
    return localDate(userId ? this.userTimeZone(userId) : this.timeZone, now);
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
  }, now) {
    const entryType = type === "income" ? "income" : type === "expense" ? "expense" : null;
    if (!entryType) throw new Error("type 必须是 expense 或 income");

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      throw new Error("金额必须是大于 0 的数字");
    }

    const amountMinor = Math.round(numericAmount * 100);
    const date = assertDate(occurredOn, "occurred_on") || this.today(userId, now);
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

  ledgerSummary(userId, options = {}, now) {
    const range = dateRange(options, this.userTimeZone(userId), now);
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

  listLedger(userId, options = {}, now) {
    const range = dateRange(options, this.userTimeZone(userId), now);
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

  addMoment(userId, { content, occurred_on: occurredOn }, now) {
    const cleanContent = String(content ?? "").trim();
    if (!cleanContent) throw new Error("小确幸内容不能为空");
    const date = assertDate(occurredOn, "occurred_on") || this.today(userId, now);

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

  lifeReview(userId, { kind = "all", period = "this_week", start_date, end_date, limit = 5 } = {}, now = Date.now()) {
    const options = { period, start_date, end_date };
    this.db.exec("BEGIN");
    try {
      const timezone = this.userTimeZone(userId);
      const range = dateRange(options, timezone, now);
      const review = { success: true, period: range.label, start_date: range.start, end_date: range.end, timezone };
      if (kind === "all" || kind === "ledger") review.ledger = this.ledgerSummary(userId, options, now);
      for (const type of ["note", "moment"]) {
        if (kind !== "all" && kind !== type) continue;
        const isNote = type === "note";
        const table = isNote ? "notes" : "moments";
        const column = isNote ? "created_at" : "occurred_on";
        const bounds = isNote ? noteTimeBounds(range, timezone) : [range.start, range.end];
        const where = `FROM ${table} WHERE user_id = ? AND ${column} BETWEEN ? AND ?`;
        const { total } = this.db.prepare(`SELECT COUNT(*) AS total ${where}`).get(userId, ...bounds);
        const records = this.db.prepare(`SELECT id, ${isNote ? "title, created_at" : "occurred_on"},
          substr(content, 1, 240) AS excerpt, length(content) > 240 AS truncated ${where}
          ORDER BY ${column} DESC, id DESC LIMIT ?`).all(userId, ...bounds, clampLimit(limit, 5, 10));
        for (const row of records) {
          if (isNote) row.local_date = localDate(timezone, Date.parse(row.created_at));
          row.truncated = Boolean(row.truncated);
        }
        review[table] = { total, records };
      }
      this.db.exec("COMMIT");
      return review;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  #recordRow(userId, kind, id) {
    if (!Object.hasOwn(recordTables, kind) || !Number.isSafeInteger(id) || id < 1) {
      throw new RecordInputError("请提供记录类型和有效编号。");
    }
    const { table, columns } = recordTables[kind];
    const row = this.db.prepare(`SELECT ${columns} FROM ${table} WHERE user_id = ? AND id = ?`).get(userId, id);
    if (!row) throw new RecordInputError("你的记录中没有这个编号，请重新查询。");
    return row;
  }

  getRecord(userId, { kind, id }) {
    return { success: true, kind, id, record: publicRecord(kind, this.#recordRow(userId, kind, id)) };
  }

  updateRecord(userId, requestId, kind, changes) {
    if (!requestId) throw new RecordInputError("缺少来源消息，请重新发送修改请求。");
    return this.executeWriteOnce(userId, requestId, "qgent_update_" + kind, changes, () => this.#editRecord(userId, kind, changes));
  }

  #editRecord(userId, kind, changes) {
    const { id, amount, category, note, occurred_on, type, content, append_content, title, tags } = changes;
    const current = this.#recordRow(userId, kind, id);
    let updated;
    if (kind === "ledger") {
      if (changes.expected_amount !== undefined && Math.round(changes.expected_amount * 100) !== current.amount_minor) {
        throw new RecordInputError("所说的原金额与这笔账目不符，请按编号查看后再修改。");
      }
      const cents = amount === undefined ? current.amount_minor : Math.round(amount * 100);
      const newCategory = category === undefined ? current.category : category.trim() || "其他";
      updated = this.db.prepare(`UPDATE ledger SET entry_type = ?, amount_minor = ?, category = ?, note = ?, occurred_on = ?
        WHERE user_id = ? AND id = ?`).run(type ?? current.type, cents, newCategory,
        note?.trim() ?? current.note, occurred_on ?? current.occurred_on, userId, id);
    } else {
      const nextContent = append_content === undefined ? content?.trim() : current.content + "\n" + append_content.trim();
      if (nextContent?.length > (kind === "note" ? 5000 : 3000)) throw new RecordInputError("修改后内容过长，请缩短后再试。");
      if (kind === "note") {
        const nextTags = tags === undefined ? undefined : normalizeTags(tags);
        if (nextTags?.length > 300) throw new RecordInputError("标签合计不能超过 300 个字符。");
        updated = this.db.prepare("UPDATE notes SET content = ?, title = ?, tags = ? WHERE user_id = ? AND id = ?")
          .run(nextContent ?? current.content, title?.trim() ?? current.title, nextTags ?? current.tags, userId, id);
      } else {
        updated = this.db.prepare("UPDATE moments SET content = ?, occurred_on = ? WHERE user_id = ? AND id = ?")
          .run(nextContent ?? current.content, occurred_on ?? current.occurred_on, userId, id);
      }
    }
    if (updated.changes !== 1) throw new RecordInputError("修改未生效，请重新查询记录。");
    return this.getRecord(userId, { kind, id });
  }

  prepareRecordDeletion(userId, { kind, id }) {
    const row = this.#recordRow(userId, kind, id);
    const fingerprint = createHash("sha256").update(JSON.stringify(row)).digest("hex");
    return { success: true, kind, id, record: publicRecord(kind, row), fingerprint };
  }

  confirmRecordDeletion(userId, requestId, { kind, id, fingerprint, expiresAt }) {
    return this.executeWriteOnce(userId, requestId, "qgent_delete_record", { kind, id }, () => {
      if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) throw new RecordInputError("删除确认已过期，请重新查看要删除的记录。");
      if (this.prepareRecordDeletion(userId, { kind, id }).fingerprint !== fingerprint) {
        throw new RecordInputError("记录在预览后已修改，请重新查看并确认删除。");
      }
      const result = this.db.prepare(`DELETE FROM ${recordTables[kind].table} WHERE user_id = ? AND id = ?`).run(userId, id);
      if (result.changes !== 1) throw new RecordInputError("删除未生效，请重新查询记录。");
      return { success: true, kind, id };
    });
  }

  #insertReminder(userId, target, text, triggerAt, timezone) {
    const result = this.db.prepare(`
      INSERT INTO reminders (user_id, scope, target_id, content, trigger_at, timezone, created_at, next_attempt_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, target.scope, target.targetId, text, triggerAt, timezone, this.nowIso(), triggerAt);
    return Number(result.lastInsertRowid);
  }

  addReminder(userId, { content, trigger_at, timezone = this.userTimeZone(userId) }, target) {
    const text = content.trim();
    if (!text || text.length > 500) throw new ReminderInputError("提醒内容应为 1 至 500 个字符。");
    const triggerAt = reminderTimestamp(trigger_at, timezone, Date.now());
    const id = this.#insertReminder(userId, target, text, triggerAt, timezone);
    return {
      success: true, id, status: "pending", scope: target.scope,
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

  getWeatherSubscription(userId) {
    return this.db.prepare(`SELECT s.*, r.status AS delivery, r.detail AS delivery_detail FROM weather_subscriptions s
      LEFT JOIN reminders r ON r.id = s.reminder_id AND r.user_id = s.user_id AND r.scope = 'c2c'
      WHERE s.user_id = ?`).get(userId);
  }

  #cancelQueuedWeather(userId, id) {
    if (id == null) return;
    // An in-flight send may still be accepted, but a subsequent 429 must
    // not re-enqueue it after the subscriber has changed or stopped it.
    this.db.prepare(`UPDATE reminders SET status = CASE status WHEN 'pending' THEN 'cancelled' ELSE status END,
      detail = '天气订阅已变更，停止后续发送' WHERE id = ? AND user_id = ? AND scope = 'c2c'
      AND status IN ('pending', 'sending')`).run(id, userId);
  }

  // Subscription changes run inside the incoming message's write-receipt transaction.
  subscribeWeather(userId, { city, check_time }, now = Date.now()) {
    const location = checkCity(city);
    const current = this.getWeatherSubscription(userId);
    const timezone = this.userTimeZone(userId);
    const next = nextWeatherCheck(now, timezone, check_time, current?.last_check_at);
    this.#cancelQueuedWeather(userId, current?.reminder_id);
    this.db.prepare(`INSERT INTO weather_subscriptions (user_id, city, timezone, check_time, next_check_at, last_result)
      VALUES (?, ?, ?, ?, ?, 'waiting')
      ON CONFLICT(user_id) DO UPDATE SET city = excluded.city, timezone = excluded.timezone,
        check_time = excluded.check_time, next_check_at = excluded.next_check_at, last_result = excluded.last_result,
        revision = revision + 1, reminder_id = NULL`).run(userId, location, timezone, check_time, next);
    return { success: true, timezone, next_check_at: next };
  }

  cancelWeatherSubscription(userId) {
    const current = this.getWeatherSubscription(userId);
    if (current?.next_check_at == null) throw new PreferenceInputError("当前没有可取消的天气订阅。");
    this.#cancelQueuedWeather(userId, current.reminder_id);
    this.db.prepare(`UPDATE weather_subscriptions SET next_check_at = NULL, city = '', timezone = '', check_time = '',
      reminder_id = NULL, revision = revision + 1, last_result = 'cancelled' WHERE user_id = ?`).run(userId);
    return { success: true };
  }

  claimWeatherCheck(now) {
    const row = this.db.prepare(`SELECT user_id, city, timezone, check_time, next_check_at, last_check_at, revision
      FROM weather_subscriptions WHERE next_check_at <= ? ORDER BY next_check_at, user_id LIMIT 1`).get(now);
    if (!row) return;
    // A long outage can leave an older date at the head of the queue even
    // while today's check is still within its catch-up window.
    const scheduled = nextWeatherCheck(now - weatherCheckWindow, row.timezone, row.check_time, row.last_check_at);
    const inWindow = scheduled <= now && scheduled >= row.next_check_at
      && localDate(row.timezone, now) === localDate(row.timezone, scheduled);
    const lastCheck = inWindow ? now : row.next_check_at;
    const next = nextWeatherCheck(now, row.timezone, row.check_time, lastCheck);
    const claimed = this.db.prepare(`UPDATE weather_subscriptions SET last_check_at = ?, next_check_at = ?,
      last_result = 'checking' WHERE user_id = ? AND revision = ? AND next_check_at = ?`)
      .run(lastCheck, next, row.user_id, row.revision, row.next_check_at);
    if (claimed.changes === 1) return { ...row, lastCheck, inWindow, scheduled };
  }

  finishWeatherCheck(claim, { status, content }, now) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(`UPDATE weather_subscriptions SET last_result = ?
        WHERE user_id = ? AND revision = ? AND last_check_at = ? AND last_result = 'checking'`)
        .run(status, claim.user_id, claim.revision, claim.lastCheck);
      if (result.changes && content) {
        const target = { scope: "c2c", targetId: claim.user_id };
        const id = this.#insertReminder(claim.user_id, target, content, now, claim.timezone);
        this.db.prepare("UPDATE weather_subscriptions SET reminder_id = ? WHERE user_id = ?").run(id, claim.user_id);
      }
      this.db.exec("COMMIT");
      return result.changes === 1;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
    // The claim clears detail before each attempt. Only a subscription
    // cancellation or change can set it while a send is in flight.
    const row = this.db.prepare(`UPDATE reminders SET
      status = CASE WHEN ? = 'pending' AND detail IS NOT NULL THEN 'cancelled' ELSE ? END,
      detail = CASE WHEN ? = 'pending' AND detail IS NOT NULL THEN detail ELSE ? END, qq_message_id = ?,
      next_attempt_at = COALESCE(?, next_attempt_at)
      WHERE id = ? AND status = 'sending' RETURNING status`).get(status, status, status, detail, messageId, retryAt, id);
    if (!row) throw new Error("提醒的发送状态已变更，未写入本次结果");
    return row.status;
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
