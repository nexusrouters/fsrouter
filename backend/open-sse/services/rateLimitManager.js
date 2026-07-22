import Bottleneck from "bottleneck";
import { parseRetryAfterFromBody } from "./accountFallback.js";
import { getProviderCategory } from "../config/providerRegistry.js";
import { getCodexRateLimitKey } from "../executors/codex.js";
import { awaitProviderDefaultSlot } from "./providerDefaultRateLimit.js";
import {
  DEFAULT_RESILIENCE_SETTINGS,
  resolveResilienceSettings
} from "../../src/lib/resilience/settings";
import {
  STANDARD_HEADERS,
  ANTHROPIC_HEADERS,
  parseResetTime,
  toPlainHeaders
} from "./rateLimitManager/headers";
function toRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function toNumber(value, fallback = 0) {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim().length > 0 ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}
function isNodeTestRunnerChild() {
  return typeof process.env.NODE_TEST_CONTEXT === "string";
}
function logRateLimit(...args) {
  if (!isNodeTestRunnerChild()) console.log(...args);
}
function warnRateLimit(...args) {
  if (!isNodeTestRunnerChild()) console.warn(...args);
}
function errorRateLimit(...args) {
  if (!isNodeTestRunnerChild()) console.error(...args);
}
const limiters = /* @__PURE__ */ new Map();
const enabledConnections = /* @__PURE__ */ new Set();
const connectionRateLimitOverrides = /* @__PURE__ */ new Map();
const learnedLimits = {};
const MAX_LEARNED_LIMITS = 200;
const INACTIVE_LIMITER_MS = 10 * 60 * 1e3;
const limiterLastUsed = /* @__PURE__ */ new Map();
let persistTimer = null;
const pendingAsyncOperations = /* @__PURE__ */ new Set();
const PERSIST_DEBOUNCE_MS = 6e4;
let initialized = false;
let currentRequestQueueSettings = DEFAULT_RESILIENCE_SETTINGS.requestQueue;
const lastDispatchAt = /* @__PURE__ */ new Map();
let watchdogInterval = null;
const WATCHDOG_INTERVAL_MS = 3e4;
const WEDGE_THRESHOLD_MS = 12e4;
function isAutoEnableActive(settings) {
  const env = process.env.RATE_LIMIT_AUTO_ENABLE?.trim().toLowerCase();
  if (env === "false" || env === "0" || env === "off") return false;
  if (env === "true" || env === "1" || env === "on") return true;
  return settings.autoEnableApiKeyProviders;
}
const EFFECTIVELY_INFINITE = Number.MAX_SAFE_INTEGER;
const EFFECTIVELY_INFINITE_CONCURRENCY = 1e3;
function resolveRpm(override) {
  return typeof override === "number" && override > 0 ? override : EFFECTIVELY_INFINITE;
}
function resolveMinTime(override) {
  return typeof override === "number" && override > 0 ? override : 0;
}
function resolveMaxConcurrent(override) {
  return typeof override === "number" && override > 0 ? override : EFFECTIVELY_INFINITE_CONCURRENCY;
}
function buildLimiterDefaults() {
  return {
    maxConcurrent: resolveMaxConcurrent(currentRequestQueueSettings.concurrentRequests),
    minTime: resolveMinTime(currentRequestQueueSettings.minTimeBetweenRequestsMs),
    reservoir: resolveRpm(currentRequestQueueSettings.requestsPerMinute),
    reservoirRefreshAmount: resolveRpm(currentRequestQueueSettings.requestsPerMinute),
    reservoirRefreshInterval: 60 * 1e3
  };
}
function updateAllLimiterSettings() {
  const defaults = buildLimiterDefaults();
  for (const limiter of limiters.values()) {
    limiter.updateSettings(defaults);
  }
}
function reconcileEnabledConnections(connectionsRaw, requestQueueSettings) {
  const nextEnabledConnections = /* @__PURE__ */ new Set();
  let explicitCount = 0;
  let autoCount = 0;
  for (const connRaw of connectionsRaw) {
    const conn = toRecord(connRaw);
    const connectionId = typeof conn.id === "string" ? conn.id : "";
    const provider = typeof conn.provider === "string" ? conn.provider : "";
    const isActive = conn.isActive === true;
    const rateLimitProtection = conn.rateLimitProtection === true;
    if (!connectionId || !provider) continue;
    if (rateLimitProtection) {
      nextEnabledConnections.add(connectionId);
      explicitCount++;
      continue;
    }
    if (isAutoEnableActive(requestQueueSettings) && getProviderCategory(provider) === "apikey" && isActive) {
      nextEnabledConnections.add(connectionId);
      autoCount++;
      getLimiter(provider, connectionId);
    }
  }
  for (const connectionId of Array.from(enabledConnections)) {
    if (!nextEnabledConnections.has(connectionId)) {
      disableRateLimitProtection(connectionId);
    }
  }
  for (const connectionId of nextEnabledConnections) {
    enabledConnections.add(connectionId);
  }
  return {
    explicitCount,
    autoCount
  };
}
function watchdogTick() {
  const now = Date.now();
  for (const [key, limiter] of Array.from(limiters)) {
    const lastUsed = limiterLastUsed.get(key) ?? 0;
    if (now - lastUsed > INACTIVE_LIMITER_MS) {
      const counts = limiter.counts();
      if (counts.QUEUED === 0 && counts.RUNNING === 0 && counts.EXECUTING === 0) {
        limiters.delete(key);
        lastDispatchAt.delete(key);
        limiterLastUsed.delete(key);
        logRateLimit(
          `\u{1F9F9} [RATE-LIMIT] Evicting idle limiter: ${key} (inactive for ${Math.round((now - lastUsed) / 1e3)}s)`
        );
        trackAsyncOperation(limiter.disconnect());
      }
    }
  }
  for (const [key, limiter] of Array.from(limiters)) {
    const counts = limiter.counts();
    if (counts.QUEUED === 0) continue;
    if (counts.RUNNING > 0 || counts.EXECUTING > 0) continue;
    const lastDispatch = lastDispatchAt.get(key);
    if (lastDispatch === void 0) {
      lastDispatchAt.set(key, now);
      continue;
    }
    const stalledMs = now - lastDispatch;
    if (stalledMs < WEDGE_THRESHOLD_MS) continue;
    warnRateLimit(
      `\u{1F6A8} [RATE-LIMIT] WEDGED: ${key} queued=${counts.QUEUED} running=0 executing=0 stalled=${stalledMs}ms \u2014 force-resetting`
    );
    limiters.delete(key);
    lastDispatchAt.delete(key);
    limiterLastUsed.delete(key);
    trackAsyncOperation(limiter.disconnect());
  }
}
let shutdownHandlersRegistered = false;
function startRateLimitWatchdog() {
  if (watchdogInterval) return;
  watchdogInterval = setInterval(watchdogTick, WATCHDOG_INTERVAL_MS);
  watchdogInterval.unref?.();
  if (!shutdownHandlersRegistered) {
    shutdownHandlersRegistered = true;
    process.once("SIGTERM", shutdownLimiters);
    process.once("SIGINT", shutdownLimiters);
  }
}
function stopRateLimitWatchdog() {
  if (!watchdogInterval) return;
  clearInterval(watchdogInterval);
  watchdogInterval = null;
}
function shutdownLimiters() {
  for (const limiter of limiters.values()) {
    limiter.stop({ dropWaitingJobs: false });
  }
  limiters.clear();
  lastDispatchAt.clear();
  limiterLastUsed.clear();
}
function trackAsyncOperation(promise) {
  pendingAsyncOperations.add(promise);
  void promise.then(
    () => {
      pendingAsyncOperations.delete(promise);
    },
    () => {
      pendingAsyncOperations.delete(promise);
    }
  );
  return promise;
}
async function initializeRateLimits() {
  if (initialized) return;
  initialized = true;
  try {
    const { getProviderConnections, getSettings } = await import('../../lib/localDb.js');
    const [connections, settings] = await Promise.all([getProviderConnections(), getSettings()]);
    const resilience = resolveResilienceSettings(settings);
    currentRequestQueueSettings = { ...resilience.requestQueue };
    const { explicitCount, autoCount } = reconcileEnabledConnections(
      connections,
      currentRequestQueueSettings
    );
    updateAllLimiterSettings();
    connectionRateLimitOverrides.clear();
    for (const conn of connections) {
      const overrides = conn.rateLimitOverrides;
      if (overrides && typeof overrides === "object" && !Array.isArray(overrides)) {
        connectionRateLimitOverrides.set(String(conn.id), overrides);
      }
    }
    if (explicitCount > 0 || autoCount > 0) {
      logRateLimit(
        `\u{1F6E1}\uFE0F [RATE-LIMIT] Loaded ${explicitCount} explicit + ${autoCount} auto-enabled protection(s)`
      );
    }
    await loadPersistedLimits();
    startRateLimitWatchdog();
  } catch (err) {
    errorRateLimit("[RATE-LIMIT] Failed to load settings:", err.message);
  }
}
async function applyRequestQueueSettings(nextSettings) {
  currentRequestQueueSettings = { ...nextSettings };
  const { getProviderConnections } = await import('../../lib/localDb.js');
  const connections = await getProviderConnections();
  reconcileEnabledConnections(connections, currentRequestQueueSettings);
  updateAllLimiterSettings();
}
function enableRateLimitProtection(connectionId) {
  enabledConnections.add(connectionId);
}
function disableRateLimitProtection(connectionId) {
  enabledConnections.delete(connectionId);
  for (const [key, limiter] of Array.from(limiters)) {
    if (key.includes(connectionId)) {
      limiters.delete(key);
      lastDispatchAt.delete(key);
      limiterLastUsed.delete(key);
      trackAsyncOperation(limiter.disconnect());
    }
  }
}
function isRateLimitEnabled(connectionId) {
  return enabledConnections.has(connectionId);
}
function refreshConnectionRateLimits(connectionId, overrides) {
  if (overrides === null || overrides === void 0) {
    connectionRateLimitOverrides.delete(connectionId);
  } else {
    connectionRateLimitOverrides.set(connectionId, overrides);
  }
  for (const [key, limiter] of Array.from(limiters)) {
    if (key.includes(connectionId)) {
      limiters.delete(key);
      lastDispatchAt.delete(key);
      limiterLastUsed.delete(key);
      trackAsyncOperation(limiter.disconnect());
    }
  }
}
function getLimiterKey(provider, connectionId, model = null) {
  if (provider === "codex" && model) {
    return `${provider}:${getCodexRateLimitKey(connectionId, model)}`;
  }
  if ((provider === "gemini" || provider === "github") && model) {
    return `${provider}:${connectionId}:${model}`;
  }
  return `${provider}:${connectionId}`;
}
function getLimiter(provider, connectionId, model = null) {
  const key = getLimiterKey(provider, connectionId, model);
  if (!limiters.has(key)) {
    const defaults = buildLimiterDefaults();
    const overrides = connectionRateLimitOverrides.get(connectionId);
    if (overrides) {
      if (typeof overrides.maxConcurrent === "number" && overrides.maxConcurrent > 0) {
        defaults.maxConcurrent = overrides.maxConcurrent;
      }
      if (typeof overrides.minTime === "number" && overrides.minTime > 0) {
        defaults.minTime = overrides.minTime;
      }
      if (typeof overrides.rpm === "number" && overrides.rpm > 0) {
        defaults.reservoir = overrides.rpm;
        defaults.reservoirRefreshAmount = overrides.rpm;
        defaults.reservoirRefreshInterval = 60 * 1e3;
      }
    }
    const limiter = new Bottleneck({
      ...defaults,
      id: key
    });
    limiter.on("executing", () => {
      lastDispatchAt.set(key, Date.now());
    });
    limiters.set(key, limiter);
    lastDispatchAt.set(key, Date.now());
    limiterLastUsed.set(key, Date.now());
  }
  limiterLastUsed.set(key, Date.now());
  return limiters.get(key);
}
async function withRateLimit(provider, connectionId, model, fn, signal = null) {
  if (!enabledConnections.has(connectionId)) {
    return fn();
  }
  if (signal?.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error) throw reason;
    const err = new Error(typeof reason === "string" ? reason : "The operation was aborted");
    err.name = "AbortError";
    throw err;
  }
  await awaitProviderDefaultSlot(
    provider,
    connectionId,
    signal,
    currentRequestQueueSettings.maxWaitMs
  );
  const limiter = getLimiter(provider, connectionId, model);
  const maxWaitMs = currentRequestQueueSettings.maxWaitMs;
  const scheduleOpts = maxWaitMs && maxWaitMs > 0 ? { expiration: maxWaitMs } : {};
  try {
    if (signal) {
      let abortListener;
      const abortPromise = new Promise((_, reject) => {
        const onAbort = () => {
          const reason = signal.reason;
          const err = reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : "The operation was aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        abortListener = onAbort;
        signal.addEventListener("abort", abortListener, { once: true });
      });
      try {
        return await Promise.race([limiter.schedule(scheduleOpts, fn), abortPromise]);
      } finally {
        if (abortListener) {
          signal.removeEventListener("abort", abortListener);
        }
      }
    } else {
      return await limiter.schedule(scheduleOpts, fn);
    }
  } catch (err) {
    if (err?.message?.includes("This job timed out")) {
      const key = getLimiterKey(provider, connectionId, model);
      logRateLimit(
        `\u23F0 [RATE-LIMIT] ${key} \u2014 job expired after ${Math.ceil((maxWaitMs || 0) / 1e3)}s in queue, dropping`
      );
      const queueErr = new Error(
        `Request dropped after exceeding the local rate-limit queue budget maxWaitMs (${maxWaitMs}ms) for ${model ? `${provider}/${model}` : provider} \u2014 this is OmniRoute's request queue (resilienceSettings.requestQueue.maxWaitMs), not an upstream timeout. Raise it in Settings \u2192 Resilience if this is queue saturation rather than a slow provider.`,
        { cause: err }
      );
      queueErr.code = "RATE_LIMIT_QUEUE_TIMEOUT";
      throw queueErr;
    }
    throw err;
  }
}
function updateFromHeaders(provider, connectionId, headers, status, model = null) {
  if (!enabledConnections.has(connectionId)) return;
  if (!headers) return;
  const plainHeaders = toPlainHeaders(headers);
  const limiter = getLimiter(provider, connectionId, model);
  const headerMap = provider === "claude" || provider === "anthropic" ? ANTHROPIC_HEADERS : STANDARD_HEADERS;
  const getHeader = (name) => {
    return plainHeaders[name.toLowerCase()] || null;
  };
  const limit = parseInt(getHeader(headerMap.limit));
  const remaining = parseInt(getHeader(headerMap.remaining));
  const resetStr = getHeader(headerMap.reset);
  const retryAfterStr = getHeader(headerMap.retryAfter);
  const overLimit = getHeader(STANDARD_HEADERS.overLimit);
  if (status === 429) {
    const retryAfterMs = parseResetTime(retryAfterStr) || 6e4;
    const counts = limiter.counts();
    const limiterKey = getLimiterKey(provider, connectionId, model);
    logRateLimit(
      `\u{1F6AB} [RATE-LIMIT] ${provider}:${connectionId.slice(0, 8)} \u2014 429 received, pausing for ${Math.ceil(retryAfterMs / 1e3)}s, dropping ${counts.QUEUED} queued request(s)`
    );
    limiters.delete(limiterKey);
    lastDispatchAt.delete(limiterKey);
    limiterLastUsed.delete(limiterKey);
    trackAsyncOperation(limiter.disconnect());
    return;
  }
  if (overLimit === "yes") {
    logRateLimit(
      `\u26A0\uFE0F [RATE-LIMIT] ${provider}:${connectionId.slice(0, 8)} \u2014 near capacity, slowing down`
    );
    limiter.updateSettings({
      minTime: 200
      // Add 200ms between requests
    });
    return;
  }
  if (!isNaN(limit) && limit > 0) {
    const resetMs = parseResetTime(resetStr) || 6e4;
    const minTime = Math.max(0, Math.floor(6e4 / limit) - 10);
    const updates = { minTime };
    if (!isNaN(remaining)) {
      if (remaining < limit * 0.1) {
        updates.reservoir = remaining;
        updates.reservoirRefreshAmount = limit;
        updates.reservoirRefreshInterval = resetMs;
        logRateLimit(
          `\u26A0\uFE0F [RATE-LIMIT] ${provider}:${connectionId.slice(0, 8)} \u2014 ${remaining}/${limit} remaining, throttling`
        );
      } else if (remaining > limit * 0.5) {
        updates.minTime = 0;
        updates.reservoir = null;
        updates.reservoirRefreshAmount = null;
        updates.reservoirRefreshInterval = null;
      }
    }
    limiter.updateSettings(updates);
    recordLearnedLimit(
      provider,
      connectionId,
      { limit, remaining, minTime: updates.minTime },
      model
    );
  }
}
function getRateLimitStatus(provider, connectionId) {
  const key = `${provider}:${connectionId}`;
  const limiter = limiters.get(key);
  if (!limiter) {
    return {
      enabled: enabledConnections.has(connectionId),
      active: false,
      queued: 0,
      running: 0
    };
  }
  const counts = limiter.counts();
  return {
    enabled: enabledConnections.has(connectionId),
    active: true,
    queued: counts.QUEUED || 0,
    running: counts.RUNNING || 0,
    executing: counts.EXECUTING || 0,
    done: counts.DONE || 0
  };
}
function getAllRateLimitStatus() {
  const result = {};
  for (const [key, limiter] of limiters) {
    const counts = limiter.counts();
    result[key] = {
      queued: counts.QUEUED || 0,
      running: counts.RUNNING || 0,
      executing: counts.EXECUTING || 0
    };
  }
  return result;
}
function getLearnedLimits() {
  return { ...learnedLimits };
}
async function persistLearnedLimitsNow() {
  try {
    const { updateSettings } = await import('../../lib/db/settings.js');
    await updateSettings({ learnedRateLimits: JSON.stringify(learnedLimits) });
    logRateLimit(
      `\u{1F4BE} [RATE-LIMIT] Persisted learned limits for ${Object.keys(learnedLimits).length} provider(s)`
    );
  } catch (err) {
    errorRateLimit("[RATE-LIMIT] Failed to persist learned limits:", err.message);
  }
}
function recordLearnedLimit(provider, connectionId, limits, model = null) {
  const key = getLimiterKey(provider, connectionId, model);
  learnedLimits[key] = {
    ...limits,
    provider,
    connectionId,
    lastUpdated: Date.now()
  };
  if (!persistTimer) {
    persistTimer = setTimeout(async () => {
      persistTimer = null;
      await trackAsyncOperation(persistLearnedLimitsNow());
    }, PERSIST_DEBOUNCE_MS);
  }
}
async function __flushLearnedLimitsForTests() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  await trackAsyncOperation(persistLearnedLimitsNow());
  if (pendingAsyncOperations.size > 0) {
    await Promise.allSettled(Array.from(pendingAsyncOperations));
  }
}
async function __resetRateLimitManagerForTests() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const disconnectPromises = [];
  for (const limiter of limiters.values()) {
    disconnectPromises.push(limiter.disconnect());
  }
  limiters.clear();
  enabledConnections.clear();
  initialized = false;
  lastDispatchAt.clear();
  limiterLastUsed.clear();
  shutdownHandlersRegistered = false;
  for (const key of Object.keys(learnedLimits)) {
    delete learnedLimits[key];
  }
  if (pendingAsyncOperations.size > 0) {
    await Promise.allSettled(Array.from(pendingAsyncOperations));
  }
  if (disconnectPromises.length > 0) {
    await Promise.allSettled(disconnectPromises);
  }
}
async function __getLimiterStateForTests(provider, connectionId, model = null) {
  const key = getLimiterKey(provider, connectionId, model);
  const limiter = limiters.get(key);
  if (!limiter) return null;
  const counts = limiter.counts();
  const reservoir = await limiter.currentReservoir();
  return {
    key,
    reservoir,
    queued: counts.QUEUED || 0,
    running: counts.RUNNING || 0,
    executing: counts.EXECUTING || 0,
    done: counts.DONE || 0
  };
}
async function loadPersistedLimits() {
  try {
    const { getSettings } = await import('../../lib/db/settings.js');
    const settings = await getSettings();
    const raw = settings?.learnedRateLimits;
    if (typeof raw !== "string" || raw.trim().length === 0) return;
    const parsed = toRecord(JSON.parse(raw));
    let count = 0;
    for (const [key, dataRaw] of Object.entries(parsed)) {
      const data = toRecord(dataRaw);
      const lastUpdated = toNumber(data.lastUpdated, 0);
      if (lastUpdated > 0 && Date.now() - lastUpdated > 24 * 60 * 60 * 1e3) continue;
      const connectionId = typeof data.connectionId === "string" ? data.connectionId : "";
      const provider = typeof data.provider === "string" ? data.provider : "";
      const limit = toNumber(data.limit, 0);
      const remaining = toNumber(data.remaining, 0);
      const minTime = toNumber(data.minTime, 0);
      learnedLimits[key] = {
        provider,
        connectionId,
        lastUpdated,
        ...limit > 0 ? { limit } : {},
        ...remaining >= 0 ? { remaining } : {},
        ...minTime >= 0 ? { minTime } : {}
      };
      if (connectionId && enabledConnections.has(connectionId)) {
        const limiter = limiters.get(key);
        if (limiter && limit > 0) {
          const inferredMinTime = minTime || Math.max(0, Math.floor(6e4 / limit) - 10);
          limiter.updateSettings({ minTime: inferredMinTime });
          count++;
        }
      }
    }
    if (count > 0) {
      logRateLimit(`\u{1F4E5} [RATE-LIMIT] Restored ${count} learned rate limit(s) from persistence`);
    }
  } catch (err) {
    errorRateLimit("[RATE-LIMIT] Failed to load persisted limits:", err.message);
  }
}
function updateFromResponseBody(provider, connectionId, responseBody, status, model = null) {
  if (!enabledConnections.has(connectionId)) return;
  const { retryAfterMs, reason } = parseRetryAfterFromBody(responseBody);
  if (retryAfterMs && retryAfterMs > 0) {
    const limiter = getLimiter(provider, connectionId, model);
    logRateLimit(
      `\u{1F6AB} [RATE-LIMIT] ${provider}:${connectionId.slice(0, 8)} \u2014 body-parsed retry: ${Math.ceil(retryAfterMs / 1e3)}s (${reason})`
    );
    limiter.updateSettings({
      reservoir: 0,
      reservoirRefreshAmount: 60,
      reservoirRefreshInterval: retryAfterMs
    });
  }
}
export {
  __flushLearnedLimitsForTests,
  __getLimiterStateForTests,
  __resetRateLimitManagerForTests,
  applyRequestQueueSettings,
  disableRateLimitProtection,
  enableRateLimitProtection,
  getAllRateLimitStatus,
  getLearnedLimits,
  getRateLimitStatus,
  initializeRateLimits,
  isRateLimitEnabled,
  refreshConnectionRateLimits,
  startRateLimitWatchdog,
  stopRateLimitWatchdog,
  updateFromHeaders,
  updateFromResponseBody,
  withRateLimit
};
