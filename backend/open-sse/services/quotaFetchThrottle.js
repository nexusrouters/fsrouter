/**
 * quotaFetchThrottle.js — global min-interval throttle for upstream quota fetches (#6009).
 *
 * Problem: when many accounts on one IP fetch provider quota, firing all the
 * network calls in the same second looks like automation to the upstream and
 * can get an OAuth token revoked.
 *
 * Solution: serialize the *actual network calls* through a single gate that
 * spaces each fetch start at least `minIntervalMs` (+ optional jitter) after the
 * previous one. Cache hits never reach the gate (the fetcher returns early), so
 * this only paces genuine upstream requests, and it is fail-open: `acquire()`
 * only ever awaits a timer, it cannot throw the quota fetch off its fail-open path.
 *
 * `minIntervalMs = 0` disables throttling entirely (byte-identical to before).
 */

const DEFAULT_MIN_INTERVAL_MS = 250;
const MAX_MIN_INTERVAL_MS = 5000;
const DEFAULT_JITTER_MS = 120;

const realClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Serializes callers so each `acquire()` resolves at least `minIntervalMs`
 * (plus up to `jitterMs`) after the previous one. Concurrent callers queue in
 * arrival order; the first through the gate is never delayed.
 */
export class MinIntervalThrottle {
  #minIntervalMs;
  #jitterMs;
  #clock;
  #rand;
  #lastStart = 0;
  #chain = Promise.resolve();

  constructor(options) {
    this.#minIntervalMs = Math.max(0, options.minIntervalMs);
    this.#jitterMs = Math.max(0, options.jitterMs ?? 0);
    this.#clock = options.clock ?? realClock;
    this.#rand = options.rand ?? Math.random;
  }

  async acquire() {
    if (this.#minIntervalMs <= 0) return; // throttling disabled — no serialization cost
    const prev = this.#chain;
    let release;
    this.#chain = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await prev;
      const now = this.#clock.now();
      if (this.#lastStart !== 0) {
        const jitter = this.#jitterMs > 0 ? Math.floor(this.#rand() * this.#jitterMs) : 0;
        const wait = this.#lastStart + this.#minIntervalMs + jitter - now;
        if (wait > 0) await this.#clock.sleep(wait);
      }
      this.#lastStart = this.#clock.now();
    } finally {
      release();
    }
  }
}

/**
 * Resolve the configured min interval (ms) from the environment, clamped to a
 * sane range. Garbage / negative → default; above the ceiling → clamped.
 */
export function resolveQuotaFetchMinIntervalMs(env = process.env) {
  const raw = env.OMNIROUTE_QUOTA_FETCH_MIN_INTERVAL_MS;
  if (raw === undefined || raw === null || raw.trim() === "") return DEFAULT_MIN_INTERVAL_MS;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MIN_INTERVAL_MS;
  return Math.min(Math.round(n), MAX_MIN_INTERVAL_MS);
}

// ─── Shared process-wide instance (used by the provider quota fetchers) ───────

let _sharedThrottle = null;

/** Lazily build (and memoize) the shared throttle from the current env config. */
export function getQuotaFetchThrottle() {
  if (!_sharedThrottle) {
    _sharedThrottle = new MinIntervalThrottle({
      minIntervalMs: resolveQuotaFetchMinIntervalMs(),
      jitterMs: DEFAULT_JITTER_MS,
    });
  }
  return _sharedThrottle;
}

/** Await the shared throttle gate before issuing an upstream quota fetch. */
export function throttleQuotaFetch() {
  return getQuotaFetchThrottle().acquire();
}

/** Test-only: reset the memoized shared throttle (e.g. after changing env). */
export function resetQuotaFetchThrottle() {
  _sharedThrottle = null;
}
