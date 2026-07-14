import { MAX_TIMER_TIMEOUT_MS } from "../../src/shared/utils/runtimeTimeouts.ts";
const PRE_SCREEN_CONCURRENCY = 5;
const DEFAULT_COMBO_TARGET_TIMEOUT_MS = 12e4;
const DEFAULT_COMBO_QUEUE_DEPTH = 20;
const MAX_COMBO_QUEUE_DEPTH = 100;
const DEFAULT_COMBO_CONFIG = {
  strategy: "priority",
  maxRetries: 1,
  retryDelayMs: 2e3,
  fallbackDelayMs: 0,
  concurrencyPerModel: 3,
  // max simultaneous requests per model (round-robin)
  queueTimeoutMs: 3e4,
  // max wait time in semaphore queue (round-robin)
  queueDepth: DEFAULT_COMBO_QUEUE_DEPTH,
  // pre-cascade semaphore queue depth (round-robin, #3872)
  handoffThreshold: 0.85,
  handoffModel: "",
  handoffProviders: ["codex"],
  maxMessagesForSummary: 30,
  maxComboDepth: 3,
  nestedComboMode: "flatten",
  trackMetrics: true,
  reasoningTokenBufferEnabled: true,
  manifestRouting: false,
  // Complexity-aware auto routing (2026): when on, the auto router scores
  // candidates by how well their tier matches the request's classified
  // difficulty (feeds tierAffinity/specificityMatch). Opt-in — off by default.
  complexityAwareRouting: false,
  resetAwareSessionWeight: 0.35,
  resetAwareWeeklyWeight: 0.65,
  resetAwareTieBandPercent: 5,
  resetAwareExhaustionGuardPercent: 10,
  failoverBeforeRetry: true,
  // Feature 4985: configurable response-body validation predicate (per-combo). When set,
  // a 200 OK whose body fails the predicate fails over to the next target.
  responseValidation: void 0,
  maxSetRetries: 0,
  setRetryDelayMs: 2e3,
  // Zero-latency optimizations are opt-in because some modes can race targets or
  // mutate fallback request bodies for lower tail latency.
  zeroLatencyOptimizationsEnabled: false,
  // Hedging (Speculative Execution) defaults
  hedging: false,
  hedgeDelayMs: 500,
  // Mid-Stream Fallback Compression defaults
  fallbackCompressionMode: "lite",
  fallbackCompressionThreshold: 1e3,
  // Predictive TTFT Circuit Breaker defaults
  predictiveTtftMs: 0,
  // Pipeline defaults
  pipeline_enabled: false,
  task_detection: "pattern",
  max_reflection_loops: 1,
  skip_pipeline_for_tokens_under: 50,
  pipeline_fallback: "single-provider",
  resetAwareQuotaCacheTtlMs: 0,
  resetAwareQuotaCacheMaxStaleMs: 0,
  shadowRouting: {
    enabled: false,
    targets: [],
    sampleRate: 1,
    maxTargets: 2,
    timeoutMs: 3e4
  },
  evalRouting: {
    enabled: false,
    suiteIds: [],
    maxAgeHours: 720,
    minCases: 1,
    qualityWeight: 0.85,
    latencyWeight: 0.15,
    cacheTtlMs: 6e4
  }
};
const LEGACY_COMBO_RESILIENCE_KEYS = /* @__PURE__ */ new Set([
  "timeoutMs",
  "healthCheckEnabled",
  "healthCheckTimeoutMs"
]);
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function normalizePositiveTimeoutMs(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) return 0;
  return Math.min(Math.floor(numericValue), MAX_TIMER_TIMEOUT_MS);
}
function resolveComboTargetTimeoutMs(config, upstreamTimeoutMs, defaultTimeoutMs = 0) {
  const ceilingTimeoutMs = normalizePositiveTimeoutMs(upstreamTimeoutMs);
  const configuredTimeoutMs = isRecord(config) ? normalizePositiveTimeoutMs(config.targetTimeoutMs) : 0;
  if (configuredTimeoutMs > 0) {
    if (ceilingTimeoutMs <= 0) return configuredTimeoutMs;
    return Math.min(configuredTimeoutMs, ceilingTimeoutMs);
  }
  const fallbackDefaultMs = normalizePositiveTimeoutMs(defaultTimeoutMs);
  if (ceilingTimeoutMs <= 0) return ceilingTimeoutMs;
  if (fallbackDefaultMs <= 0) return ceilingTimeoutMs;
  return Math.min(fallbackDefaultMs, ceilingTimeoutMs);
}
function resolveComboQueueDepth(config) {
  const raw = isRecord(config) ? Number(config.queueDepth) : Number.NaN;
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_COMBO_QUEUE_DEPTH;
  return Math.min(Math.floor(raw), MAX_COMBO_QUEUE_DEPTH);
}
function resolveComboConfig(combo, settings, provider) {
  const global = settings?.comboDefaults || {};
  const providerOverride = provider ? settings?.providerOverrides?.[provider] || {} : {};
  const comboConfig = combo?.config || {};
  const clean = (obj) => Object.fromEntries(
    Object.entries(obj).filter(
      ([key, value]) => value !== void 0 && value !== null && !LEGACY_COMBO_RESILIENCE_KEYS.has(key)
    )
  );
  const merged = {
    ...DEFAULT_COMBO_CONFIG,
    ...clean(global),
    ...clean(providerOverride),
    ...clean(comboConfig)
  };
  return {
    ...merged,
    shadowRouting: {
      ...DEFAULT_COMBO_CONFIG.shadowRouting,
      ...isRecord(global.shadowRouting) ? clean(global.shadowRouting) : {},
      ...isRecord(providerOverride.shadowRouting) ? clean(providerOverride.shadowRouting) : {},
      ...isRecord(comboConfig.shadowRouting) ? clean(comboConfig.shadowRouting) : {}
    },
    evalRouting: {
      ...DEFAULT_COMBO_CONFIG.evalRouting,
      ...isRecord(global.evalRouting) ? clean(global.evalRouting) : {},
      ...isRecord(providerOverride.evalRouting) ? clean(providerOverride.evalRouting) : {},
      ...isRecord(comboConfig.evalRouting) ? clean(comboConfig.evalRouting) : {}
    }
  };
}
function getDefaultComboConfig() {
  return { ...DEFAULT_COMBO_CONFIG };
}
function resolveComboSetupConfig(combo, settings) {
  return settings ? resolveComboConfig(combo, settings) : { ...getDefaultComboConfig(), ...combo?.config || {} };
}
export {
  DEFAULT_COMBO_QUEUE_DEPTH,
  DEFAULT_COMBO_TARGET_TIMEOUT_MS,
  MAX_COMBO_QUEUE_DEPTH,
  PRE_SCREEN_CONCURRENCY,
  getDefaultComboConfig,
  resolveComboConfig,
  resolveComboQueueDepth,
  resolveComboSetupConfig,
  resolveComboTargetTimeoutMs
};
