const MAX_KEYS = 5e3;
class SlidingWindowLimiter {
  hits = /* @__PURE__ */ new Map();
  now;
  constructor(opts = {}) {
    this.now = opts.now ?? Date.now;
  }
  /**
   * Try to consume one slot for `key`. Records a timestamp and returns
   * `{allowed:true}` when under the cap; returns `{allowed:false, retryAfterMs}`
   * (without recording) when the trailing window is saturated.
   */
  tryAcquire(key, window) {
    const { requests, windowMs } = window;
    if (!(requests > 0) || !(windowMs > 0)) return { allowed: true, retryAfterMs: 0 };
    const now = this.now();
    const cutoff = now - windowMs;
    const previous = this.hits.get(key);
    const live = previous ? previous.filter((ts) => ts > cutoff) : [];
    if (live.length >= requests) {
      const retryAfterMs = Math.max(0, live[0] + windowMs - now);
      this.hits.set(key, live);
      return { allowed: false, retryAfterMs };
    }
    live.push(now);
    this.set(key, live);
    return { allowed: true, retryAfterMs: 0 };
  }
  /** Clear history for one key, or all keys when called with no argument. */
  reset(key) {
    if (key === void 0) this.hits.clear();
    else this.hits.delete(key);
  }
  set(key, live) {
    if (!this.hits.has(key) && this.hits.size >= MAX_KEYS) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== void 0) this.hits.delete(oldest);
    }
    this.hits.set(key, live);
  }
}
export {
  SlidingWindowLimiter
};
