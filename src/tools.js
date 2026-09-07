export const qgentTools = [
  {
    type: "function",
    name: "qgent_add_note",
    description:
      "把用户明确要求保存/记下的普通笔记持久化保存。只有用户确实要求记录时才调用；不要因为普通聊天内容看起来有用就擅自保存。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "可选的简短标题" },
        content: { type: "string", description: "需要保存的完整笔记内容" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "可选标签，例如 工作、生活、购物",
        },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "qgent_search_notes",
    description:
      "查询用户已经持久化保存的笔记。用户问‘我之前记了什么’、‘找一下某条笔记’等时调用。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词；留空表示查看最近笔记" },
        limit: { type: "integer", minimum: 1, maximum: 30 },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "qgent_add_ledger",
    description:
      "把用户明确表达的一笔收入或支出持久化记账。金额单位为人民币元。一次调用只记一笔；如果用户一次说了多笔账，可以多次调用。",
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["expense", "income"],
          description: "expense=支出，income=收入",
        },
        amount: { type: "number", exclusiveMinimum: 0, description: "金额，单位元" },
        category: {
          type: "string",
          description: "分类，如 餐饮、交通、购物、房租、工资、红包；不确定可用‘其他’",
        },
        note: { type: "string", description: "可选备注" },
        occurred_on: {
          type: "string",
          description: "发生日期 YYYY-MM-DD。用户没有指定日期时可以省略，工具会按今天记录。",
        },
      },
      required: ["type", "amount"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "qgent_ledger_summary",
    description:
      "统计用户已保存账目的收入、支出、结余和主要支出分类。用户问今天/本月/上月花了多少、收入多少、账目情况时调用。",
    parameters: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: ["today", "this_month", "last_month", "all"],
          description: "常用统计周期，默认 this_month",
        },
        start_date: { type: "string", description: "自定义开始日期 YYYY-MM-DD" },
        end_date: { type: "string", description: "自定义结束日期 YYYY-MM-DD" },
        category: { type: "string", description: "可选，只统计某分类" },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "qgent_list_ledger",
    description:
      "查看已经保存的具体账目明细。当用户想看最近几笔、本月具体账单时调用。",
    parameters: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: ["today", "this_month", "last_month", "all"],
        },
        start_date: { type: "string", description: "自定义开始日期 YYYY-MM-DD" },
        end_date: { type: "string", description: "自定义结束日期 YYYY-MM-DD" },
        limit: { type: "integer", minimum: 1, maximum: 30 },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "qgent_add_moment",
    description:
      "把用户明确想记录的一件生活小确幸、开心的小事或值得纪念的小瞬间持久化保存。不要添加用户没有说过的细节。",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "要保存的小确幸内容" },
        occurred_on: {
          type: "string",
          description: "发生日期 YYYY-MM-DD；未指定时可以省略，工具按今天记录",
        },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "qgent_list_moments",
    description:
      "查看用户以前保存的小确幸。用户想回顾最近开心的事、小确幸记录时调用。",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 30 },
      },
      additionalProperties: false,
    },
  },
];

function parseArgs(raw) {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value;
  } catch {
    throw new Error("工具参数不是合法 JSON");
  }
}

export async function executeQgentTool({ call, userId, store }) {
  if (!userId) throw new Error("缺少用户标识，不能读写私人数据");
  const args = parseArgs(call.arguments);

  switch (call.name) {
    case "qgent_add_note":
      return store.addNote(userId, args);
    case "qgent_search_notes":
      return store.searchNotes(userId, args);
    case "qgent_add_ledger":
      return store.addLedgerEntry(userId, args);
    case "qgent_ledger_summary":
      return store.ledgerSummary(userId, args);
    case "qgent_list_ledger":
      return store.listLedger(userId, args);
    case "qgent_add_moment":
      return store.addMoment(userId, args);
    case "qgent_list_moments":
      return store.listMoments(userId, args);
    default:
      throw new Error(`未知工具: ${call.name}`);
  }
}
