import OpenAI from "openai";

export class DeepSeekClient {
  constructor({ apiKey, baseURL, model, timeoutMs, systemPrompt }) {
    this.model = model;
    this.systemPrompt = systemPrompt;
    this.client = new OpenAI({
      apiKey,
      baseURL,
      timeout: timeoutMs,
      maxRetries: 2,
    });
  }

  async chat({ history, prompt }) {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: this.systemPrompt },
        ...history,
        { role: "user", content: prompt },
      ],
      stream: false,
    });

    const content = completion.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("DeepSeek returned an empty response");
    return content;
  }
}
