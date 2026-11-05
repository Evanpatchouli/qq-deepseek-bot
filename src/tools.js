export const qgentTools = [
  {
    type: "function",
    name: "qgent_get_weather",
    description: "通过 UAPI 查询指定城市/地区的实时天气。询问天气、气温、下雨或基于天气的穿衣建议时优先调用。city 必须来自用户、对话或配置的默认地点，不可猜测。预报及体感等字段仅在服务配置支持时返回。",
    parameters: {
      type: "object",
      properties: { city: { type: "string", minLength: 1, maxLength: 100, description: "明确的城市/地区名称，例如乌鲁木齐、北京市海淀区" } },
      required: ["city"],
      additionalProperties: false,
    },
  },
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

export const writeToolNames = new Set(["qgent_add_note", "qgent_add_ledger", "qgent_add_moment"]);

// A separate key permits two intentionally identical records in one message.
for (const tool of qgentTools) {
  const limits = { title: 120, query: 500, category: 80, note: 500,
    content: tool.name === "qgent_add_moment" ? 3000 : 5000 };
  for (const [field, maximum] of Object.entries(limits)) {
    if (tool.parameters.properties[field]) tool.parameters.properties[field].maxLength = maximum;
  }
  if (writeToolNames.has(tool.name)) {
    tool.parameters.properties.record_key = {
      type: "string", maxLength: 80,
      description: "同一消息确实包含多条完全相同的记录时，分别使用不同编号；重试同一条必须保持编号不变。通常省略。",
    };
  }
}

function validateValue(value, schema, field) {
  if (schema.type === "string" && (typeof value !== "string" ||
      value.length > (schema.maxLength ?? 5000))) throw new Error(`${field} 必须是长度合适的文本`);
  if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
    throw new Error(`${field} 必须是大于 0 的数字`);
  }
  if (schema.type === "integer" && (!Number.isInteger(value) || value < schema.minimum || value > schema.maximum)) {
    throw new Error(`${field} 超出允许范围`);
  }
  if (schema.type === "array") {
    if (!Array.isArray(value) || value.length > 10) throw new Error(`${field} 必须是最多 10 项的列表`);
    for (const item of value) validateValue(item, schema.items, field);
  }
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${field} 不是允许的值`);
  if (["content", "city"].includes(field) && !value.trim()) throw new Error(`${field} 不能为空`);
  if (["occurred_on", "start_date", "end_date"].includes(field)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
      throw new Error(`${field} 必须是真实的 YYYY-MM-DD 日期`);
    }
  }
}

function parseArgs(raw, tool) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("工具参数不是合法 JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("工具参数必须是 JSON 对象");
  const schema = tool.parameters;
  for (const key of schema.required ?? []) {
    if (!(key in value)) throw new Error(`缺少工具参数 ${key}`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (!Object.hasOwn(schema.properties, key)) throw new Error(`不支持的工具参数 ${key}`);
    validateValue(item, schema.properties[key], key);
    if (key === "amount" && (!Number.isSafeInteger(Math.round(item * 100)) || Math.round(item * 100) <= 0)) {
      throw new Error("金额超出允许范围或不足一分");
    }
  }
  if (value.start_date && value.end_date && value.start_date > value.end_date) throw new Error("开始日期不能晚于结束日期");
  return value;
}

/** Execute a validated tool in the authenticated QQ user's context. */
export async function executeQgentTool({ call, userId, store, weather, requestId, signal }) {
  signal?.throwIfAborted();
  if (typeof userId !== "string" || !userId.trim()) throw new Error("缺少用户标识，不能读写私人数据");
  const tool = qgentTools.find((item) => item.name === call.name);
  if (!tool) throw new Error("未知工具");
  const args = parseArgs(call.arguments, tool);
  if (call.name === "qgent_get_weather") {
    if (!weather) throw new Error("天气服务未配置");
    return weather.getWeather(args, { signal });
  }
  if (!store) throw new Error("Qgent persistent store is not configured");
  const methods = {
    qgent_add_note: "addNote", qgent_search_notes: "searchNotes",
    qgent_add_ledger: "addLedgerEntry", qgent_ledger_summary: "ledgerSummary",
    qgent_list_ledger: "listLedger", qgent_add_moment: "addMoment",
    qgent_list_moments: "listMoments",
  };
  const execute = () => store[methods[call.name]](userId, args);
  if (requestId && writeToolNames.has(call.name)) {
    return store.executeWriteOnce(userId, requestId, call.name, args, execute);
  }
  return execute();
}
