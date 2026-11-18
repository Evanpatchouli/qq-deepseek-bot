export class ConversationMemory {
  #store = new Map();

  constructor({ maxTurns = 8, ttlMs = 2 * 60 * 60 * 1000 } = {}) {
    this.maxMessages = maxTurns * 2;
    this.ttlMs = ttlMs;
  }

  #entry(key) {
    const item = this.#store.get(key);
    if (item && Date.now() - item.updatedAt > this.ttlMs) {
      this.#store.delete(key);
      return;
    }
    return item;
  }

  get(key) {
    return this.#entry(key)?.messages.map((message) => ({ ...message })) ?? [];
  }

  getRecordState(key) {
    return this.#entry(key)?.recordState;
  }

  clearRecordReferences(key, keepRequestId) {
    const state = this.getRecordState(key);
    if (state && state.requestId !== keepRequestId) state.references = [];
  }

  appendTurn(key, userContent, assistantContent, recordState) {
    const messages = this.get(key);
    messages.push(
      { role: "user", content: userContent },
      { role: "assistant", content: assistantContent },
    );

    this.#store.set(key, {
      messages: messages.slice(-this.maxMessages),
      updatedAt: Date.now(),
      recordState,
    });
  }

  clear(key) {
    this.#store.delete(key);
  }

  clearExpired() {
    const now = Date.now();
    for (const [key, item] of this.#store) {
      if (now - item.updatedAt > this.ttlMs) this.#store.delete(key);
    }
  }

  get size() {
    return this.#store.size;
  }
}
