import OpenAI from "openai";
import { executeQgentTool, qgentTools } from "./tools.js";

function extractOutputText(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const parts = [];
  for (const item of response?.output ?? []) {
    if (item?.type !== "message") continue;
    for (const content of item.content ?? []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }

  return parts.join("\n").trim();
}

function countWebSearchCalls(response) {
  return (response?.output ?? []).filter((item) => item?.type === "web_search_call").length;
}

function functionCalls(response) {
  return (response?.output ?? []).filter((item) => item?.type === "function_call");
}

function currentTimeText(timeZone) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date());
  } catch {
    return new Date().toISOString();
  }
}

export class DeepSeekClient {
  constructor({
    apiKey,
    baseURL,
    model,
    timeoutMs,
    systemPrompt,
    webSearchEnabled = true,
    defaultLocation = "",
    timeZone = "Asia/Shanghai",
    maxToolRounds = 5,
    store,
  }) {
    this.model = model;
    this.webSearchEnabled = webSearchEnabled;
    this.defaultLocation = defaultLocation;
    this.timeZone = timeZone;
    this.maxToolRounds = maxToolRounds;
    this.store = store;

    const locationPrompt = defaultLocation
      ? `\n\n【默认地点】用户未明确指定地点、但询问天气、穿衣、附近生活信息时，默认地点为“${defaultLocation}”。如果用户明确指定其他地点，以用户本次指定地点为准。`
      : "\n\n【地点规则】如果用户询问天气、穿衣或附近生活信息，但当前消息和已有对话都无法确定地点，请先询问城市或地区，不要猜测用户所在位置。";

    const toolPrompt = `\n\n【Qgent 的真实生活工具】你可以使用持久化工具保存和读取笔记、账目、小确幸。用户明确说“记一下、保存、记账、记个笔记、记录小确幸”等时，应该调用对应工具，而不是只在聊天里口头答应。只有工具返回 success=true 后才能告诉用户已经记下。用户只是讨论、举例或询问怎么做时，不要擅自写入。所有记录按当前 QQ 用户隔离。用户询问已经保存的数据时，应调用查询/统计工具，不要凭聊天记忆猜。账目当前默认人民币 CNY。`;

    this.baseInstructions = `${systemPrompt}${locationPrompt}${toolPrompt}`;

    this.client = new OpenAI({
      apiKey,
      baseURL,
      timeout: timeoutMs,
      maxRetries: 2,
    });
  }

  #instructions() {
    return `${this.baseInstructions}\n\n【当前时间】${currentTimeText(this.timeZone)}（时区 ${this.timeZone}）。涉及“今天、昨天、本月”等相对日期时以此为准。`;
  }

  #tools() {
    const tools = [...qgentTools];
    if (this.webSearchEnabled) tools.push({ type: "web_search" });
    return tools;
  }

  async chat({ history, prompt, userId }) {
    let input = [
      ...history,
      { role: "user", content: prompt },
    ];

    let totalWebSearchCalls = 0;
    let localToolCalls = 0;
    let finalResponse = null;

    for (let round = 0; round < this.maxToolRounds; round += 1) {
      const response = await this.client.responses.create({
        model: this.model,
        instructions: this.#instructions(),
        input,
        tools: this.#tools(),
        tool_choice: "auto",
        stream: false,
      });

      finalResponse = response;
      totalWebSearchCalls += countWebSearchCalls(response);
      const calls = functionCalls(response);

      if (calls.length === 0) break;
      if (!this.store) throw new Error("Qgent persistent store is not configured");

      input = [...input, ...(response.output ?? [])];

      for (const call of calls) {
        localToolCalls += 1;
        let result;
        try {
          result = await executeQgentTool({ call, userId, store: this.store });
          console.log(`[tool] user=${userId} name=${call.name} success=true`);
        } catch (error) {
          result = { success: false, error: String(error?.message || error) };
          console.error(`[tool] user=${userId} name=${call.name} success=false`, error);
        }

        input.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result),
        });
      }
    }

    const content = extractOutputText(finalResponse);
    if (!content) {
      throw new Error("DeepSeek returned an empty response or exceeded the local tool round limit");
    }

    const usage = finalResponse?.usage;
    console.log(
      `[deepseek] web_search=${totalWebSearchCalls > 0} web_calls=${totalWebSearchCalls} local_tools=${localToolCalls}` +
        (usage
          ? ` input_tokens=${usage.input_tokens ?? "?"} output_tokens=${usage.output_tokens ?? "?"}`
          : ""),
    );

    return content;
  }
}
