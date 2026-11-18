import { randomBytes } from "node:crypto";

export const recordLabels = { ledger: "账目", note: "笔记", moment: "小确幸" };
export const updateTools = {
  qgent_update_ledger: "ledger", qgent_update_note: "note", qgent_update_moment: "moment",
};
export const prepareDeletionTool = "qgent_prepare_record_deletion";
export class RecordInputError extends Error {}

const addedKinds = { qgent_add_ledger: "ledger", qgent_add_note: "note", qgent_add_moment: "moment" };
const listedKinds = {
  qgent_list_ledger: ["ledger", "entries"], qgent_search_notes: ["note", "notes"],
  qgent_list_moments: ["moment", "moments"],
};

export function recordLabel(kind, id) {
  return `${recordLabels[kind]} #${id}`;
}

export function savedStatus(results) {
  if (!results.length) return "没有查到已完成的记录操作。";
  const entries = results.map(({ name, kind, id }) => {
    if (Object.hasOwn(addedKinds, name)) return "保存" + recordLabel(addedKinds[name], id);
    if (Object.hasOwn(updateTools, name)) return "修改" + recordLabel(updateTools[name], id);
    if (name === "qgent_delete_record") return "删除" + recordLabel(kind, id);
    if (name === "qgent_create_reminder") return `登记提醒 #${id}`;
    if (name === "qgent_cancel_reminder") return `取消提醒 #${id}`;
    return `记录 #${id}`;
  });
  return "已执行的操作包括" + entries.join("、") + "。可按编号核对。";
}

function excerpt(value, length) {
  const text = value.replace(/\s+/gu, " ").trim();
  return text.length > length ? text.slice(0, length) + "…" : text;
}

export function describeRecord(kind, row) {
  const label = recordLabel(kind, row.id);
  if (kind === "ledger") {
    const type = row.type === "income" ? "收入" : "支出";
    return `${label}　${row.occurred_on} ${type} ${row.amount.toFixed(2)} 元　${excerpt([row.category, row.note].filter(Boolean).join(" · "), 120)}`;
  }
  const heading = kind === "note" ? row.title : row.occurred_on;
  return `${label}　${excerpt([heading, row.content].filter(Boolean).join(" · "), 160)}`;
}

// Only an inbound reference or records actually returned in the preceding turn
// can authorize an edit. A lookup chosen by the model in this turn cannot.
export class RecordTurn {
  constructor(prompt, previous = []) {
    this.prompt = prompt.normalize("NFKC");
    this.previous = previous;
    this.state = { references: [], deletion: null };
    this.writes = new Set();
  }

  allows(kind, id) {
    const mentions = [...this.prompt.matchAll(/(?:(账目|账单|笔记|小确幸)\s*)?#\s*(\d+)(?![\da-z_]|\.\d)/giu)];
    const markers = this.prompt.match(/#\s*(?=[+\-.\d])/gu) ?? [];
    if (markers.length) {
      if (mentions.length !== 1 || markers.length !== 1) return false;
      const [, label, number] = mentions[0];
      if (Number(number) !== id) return false;
      if (label) return (label === "账单" ? "账目" : label) === recordLabels[kind];
    }
    const kinds = Object.keys(recordLabels).filter((key) => this.prompt.includes(recordLabels[key]) ||
      (key === "ledger" && /账单|那笔|这笔|一笔/u.test(this.prompt)));
    if (kinds.length && (kinds.length !== 1 || kinds[0] !== kind)) return false;
    if (mentions.length && kinds.length === 1) return true;
    if (!mentions.length && !/刚才|上一[笔条个]|[这那][一]?[笔条个]|把它/u.test(this.prompt)) return false;
    const candidates = this.previous.filter((ref) => (!kinds.length || ref.kind === kind) &&
      (!mentions.length || ref.id === id));
    return candidates.length === 1 && candidates[0].kind === kind && candidates[0].id === id;
  }

  observe(name, result) {
    const list = listedKinds[name];
    const kind = list?.[0] ?? addedKinds[name] ?? updateTools[name] ??
      ((name === "qgent_get_record" || name === prepareDeletionTool) ? result.kind : undefined);
    const rows = list ? result[list[1]] : [result];
    if (!Object.hasOwn(recordLabels, kind)) return;
    for (const row of rows) {
      if (!Number.isSafeInteger(row.id)) continue;
      if (!this.state.references.some((ref) => ref.kind === kind && ref.id === row.id)) {
        this.state.references.push({ kind, id: row.id });
      }
      if (Object.hasOwn(addedKinds, name) || Object.hasOwn(updateTools, name)) {
        const action = Object.hasOwn(addedKinds, name) ? "已保存" : "已修改";
        this.writes.add(action + recordLabel(kind, row.id));
      }
    }
  }

  deletionPreview({ kind, id, record, fingerprint }) {
    const code = randomBytes(4).toString("hex");
    this.state.deletion = { kind, id, fingerprint, code, expiresAt: Date.now() + 10 * 60_000 };
    return `待删除的记录\n${describeRecord(kind, record)}\n如要删除，请在 10 分钟内在本会话回复“确认删除 ${code}”。`;
  }

  withWriteReceipts(text) {
    const missing = [...this.writes].filter((receipt) => !new RegExp(receipt + "(?!\\d)", "u").test(text));
    return [text, ...missing].join("\n");
  }
}
