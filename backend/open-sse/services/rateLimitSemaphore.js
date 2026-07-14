const gates = /* @__PURE__ */ new Map();
function getGate(modelStr, maxConcurrency = 3) {
  if (!gates.has(modelStr)) {
    gates.set(modelStr, {
      running: 0,
      max: maxConcurrency,
      queue: [],
      rateLimitedUntil: null
    });
  }
  const gate = gates.get(modelStr);
  gate.max = maxConcurrency;
  return gate;
}
function isRateLimited(gate) {
  if (!gate.rateLimitedUntil) return false;
  if (Date.now() >= gate.rateLimitedUntil) {
    gate.rateLimitedUntil = null;
    return false;
  }
  return true;
}
function drainQueue(modelStr) {
  const gate = gates.get(modelStr);
  if (!gate) return;
  while (gate.queue.length > 0 && gate.running < gate.max && !isRateLimited(gate)) {
    const next = gate.queue.shift();
    if (!next) break;
    clearTimeout(next.timer);
    gate.running++;
    next.resolve(createReleaseFn(modelStr));
  }
  if (gate.running === 0 && gate.queue.length === 0) {
    gates.delete(modelStr);
  }
}
function createReleaseFn(modelStr) {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const gate = gates.get(modelStr);
    if (gate && gate.running > 0) {
      gate.running--;
      if (gate.running === 0 && gate.queue.length === 0) {
        gates.delete(modelStr);
        return;
      }
      drainQueue(modelStr);
    }
  };
}
function acquire(modelStr, { maxConcurrency = 3, timeoutMs = 3e4, maxQueueSize } = {}) {
  const gate = getGate(modelStr, maxConcurrency);
  if (gate.running < gate.max && !isRateLimited(gate)) {
    gate.running++;
    return Promise.resolve(createReleaseFn(modelStr));
  }
  if (typeof maxQueueSize === "number" && maxQueueSize >= 0 && gate.queue.length >= maxQueueSize) {
    const err = new Error(`Semaphore queue full (${maxQueueSize}) for ${modelStr}`);
    err.code = "SEMAPHORE_QUEUE_FULL";
    if (gate.running === 0 && gate.queue.length === 0) gates.delete(modelStr);
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = gate.queue.findIndex((item) => item.timer === timer);
      if (idx !== -1) gate.queue.splice(idx, 1);
      const err = new Error(`Semaphore timeout after ${timeoutMs}ms for ${modelStr}`);
      err.code = "SEMAPHORE_TIMEOUT";
      reject(err);
    }, timeoutMs);
    gate.queue.push({ resolve, reject, timer });
  });
}
function markRateLimited(modelStr, cooldownMs) {
  const gate = getGate(modelStr);
  gate.rateLimitedUntil = Date.now() + cooldownMs;
  setTimeout(() => {
    if (gate.rateLimitedUntil && Date.now() >= gate.rateLimitedUntil) {
      gate.rateLimitedUntil = null;
      drainQueue(modelStr);
    }
  }, cooldownMs + 50);
}
function getStats() {
  const stats = {};
  for (const [model, gate] of gates) {
    stats[model] = {
      running: gate.running,
      queued: gate.queue.length,
      max: gate.max,
      rateLimitedUntil: gate.rateLimitedUntil ? new Date(gate.rateLimitedUntil).toISOString() : null
    };
  }
  return stats;
}
function resetAll() {
  for (const [, gate] of gates) {
    for (const item of gate.queue) {
      clearTimeout(item.timer);
      item.reject(new Error("Semaphore reset"));
    }
  }
  gates.clear();
}
export {
  acquire,
  getStats,
  markRateLimited,
  resetAll
};
