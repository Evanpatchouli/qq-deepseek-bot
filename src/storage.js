import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

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
  constructor({ dbPath, timeZone = "Asia/Shanghai" }) {
    this.dbPath = path.resolve(dbPath);
    this.timeZone = timeZone;

    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath, { timeout: 5000 });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.#migrate();
  }

  #migrate() {
    this.db.exec(`
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
    `);
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

  close() {
    if (this.db?.isOpen) this.db.close();
  }
}
