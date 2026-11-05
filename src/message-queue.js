/** Bounded in-process scheduling; each conversation retains arrival order. */
export function createMessageQueue({ concurrency = 4, capacity = 64, perConversation = 8 } = {}) {
  const pending = [];
  const active = new Set();
  const counts = new Map();
  const rates = new Map();
  function pump() {
    while (active.size < concurrency) {
      const index = pending.findIndex((job) => !active.has(job.key));
      if (index < 0) return;
      const job = pending.splice(index, 1)[0];
      active.add(job.key);
      Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => {
        active.delete(job.key);
        const remaining = counts.get(job.key) - 1;
        if (remaining) counts.set(job.key, remaining);
        else counts.delete(job.key);
        pump();
      });
    }
  }
  return (key, rateKeys, run) => {
    if (pending.length + active.size >= capacity || (counts.get(key) ?? 0) >= perConversation) {
      return Promise.reject(new Error("消息队列已满，请稍后再试。"));
    }
    const now = Date.now();
    for (const [id, rate] of rates) if (rate.until <= now) rates.delete(id);
    if (rateKeys.some(([id, limit]) => (rates.get(id)?.count ?? 0) >= limit)) {
      return Promise.reject(new Error("消息太频繁，请一分钟后再试。"));
    }
    for (const [id] of rateKeys) {
      const rate = rates.get(id) ?? { count: 0, until: now + 60_000 };
      rate.count++;
      rates.set(id, rate);
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return new Promise((resolve, reject) => {
      pending.push({ key, run, resolve, reject });
      pump();
    });
  };
}
