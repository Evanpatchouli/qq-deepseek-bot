import OpenAI from "openai";

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

export class DeepSeekClient {
  constructor({
    apiKey,
    baseURL,
    model,
    timeoutMs,
    systemPrompt,
    webSearchEnabled = true,
    defaultLocation = "",
  }) {
    this.model = model;
    this.webSearchEnabled = webSearchEnabled;
    this.defaultLocation = defaultLocation;

    const locationPrompt = defaultLocation
      ? `\n\n【默认地点】用户未明确指定地点、但询问天气、穿衣、附近生活信息时，默认地点为“${defaultLocation}”。如果用户明确指定其他地点，以用户本次指定地点为准。`
      : "\n\n【地点规则】如果用户询问天气、穿衣或附近生活信息，但当前消息和已有对话都无法确定地点，请先询问城市或地区，不要猜测用户所在位置。";

    this.instructions = `${systemPrompt}${locationPrompt}`;

    this.client = new OpenAI({
      apiKey,
      baseURL,
      timeout: timeoutMs,
      maxRetries: 2,
    });
  }

  async chat({ history, prompt }) {
    const request = {
      model: this.model,
      instructions: this.instructions,
      input: [
        ...history,
        { role: "user", content: prompt },
      ],
      stream: false,
    };

    if (this.webSearchEnabled) {
      request.tools = [{ type: "web_search" }];
      request.tool_choice = "auto";
    }

    const response = await this.client.responses.create(request);
    const content = extractOutputText(response);

    if (!content) {
      throw new Error("DeepSeek returned an empty response");
    }

    const webSearchCalls = countWebSearchCalls(response);
    const usage = response?.usage;
    console.log(
      `[deepseek] web_search=${webSearchCalls > 0} calls=${webSearchCalls}` +
        (usage
          ? ` input_tokens=${usage.input_tokens ?? "?"} output_tokens=${usage.output_tokens ?? "?"}`
          : ""),
    );

    return content;
  }
}
