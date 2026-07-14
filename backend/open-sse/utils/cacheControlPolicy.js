const DETERMINISTIC_STRATEGIES = /* @__PURE__ */ new Set(["priority", "cost-optimized"]);
const CACHING_PROVIDERS = /* @__PURE__ */ new Set([
  "claude",
  "anthropic",
  "zai",
  "qwen",
  "deepseek",
  // #3088 — Xiaomi MiMo honors OpenAI-format cache_control breakpoints. Without
  // this entry, shouldPreserveCacheControl() returns false for Claude Code
  // clients and filterToOpenAIFormat() strips cache_control, so Xiaomi never
  // sees the cache hints and every request is a cache miss.
  "xiaomi-mimo",
  // #3955 — OpenAI / Codex / Azure-OpenAI use AUTOMATIC prefix caching: the longest
  // matching prefix of a request is cached upstream WITHOUT any explicit cache_control
  // markers. They must count as caching providers so the cache-aware compression guard
  // preserves the cacheable prefix (system prompt / earliest messages) instead of
  // rewriting it and forcing a cache miss. This also activates the intended
  // `prompt_cache_key` cache-routing hint for OpenAI in chatCore.
  "openai",
  "codex",
  "azure",
  // #2069 — Alibaba DashScope's OpenAI-compatible endpoints (alibaba /
  // alibaba-cn, upstream "alicode"/"alicode-intl") natively honor
  // `cache_control: {type:"ephemeral"}` breakpoints. Without these entries
  // shouldPreserveCacheControl() returns false for Claude Code clients and the
  // OpenAI-format translator strips cache_control, so DashScope never sees the
  // hints and every request is a cache miss.
  "alibaba",
  "alibaba-cn"
]);
const OPENAI_FORMAT_CACHE_CONTROL_PROVIDERS = /* @__PURE__ */ new Set([
  // #2069 — DashScope OpenAI-compatible endpoints accept ephemeral breakpoints.
  "alibaba",
  "alibaba-cn",
  // #3088 — Xiaomi MiMo honors OpenAI-format cache_control breakpoints.
  "xiaomi-mimo"
]);
function providerHonorsOpenAIFormatCacheControl(provider) {
  if (!provider) return false;
  return OPENAI_FORMAT_CACHE_CONTROL_PROVIDERS.has(provider.toLowerCase());
}
function isClaudeCodeClient(userAgent) {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  if (ua.includes("claude-code") || ua.includes("claude_code")) return true;
  if (ua.includes("claude-cli/")) return true;
  if (ua.includes("sdk-cli")) return true;
  if (ua.includes("anthropic") && ua.includes("cli")) return true;
  return false;
}
function providerSupportsCaching(provider, targetFormat) {
  if (!provider) return false;
  if (CACHING_PROVIDERS.has(provider.toLowerCase())) return true;
  if (targetFormat === "claude") return true;
  return false;
}
function isDeterministicStrategy(strategy) {
  if (!strategy) return false;
  return DETERMINISTIC_STRATEGIES.has(strategy);
}
function shouldPreserveCacheControl({
  userAgent,
  isCombo,
  comboStrategy,
  targetProvider,
  targetFormat,
  settings
}) {
  if (settings?.alwaysPreserveClientCache === "always") {
    return true;
  }
  if (settings?.alwaysPreserveClientCache === "never") {
    return false;
  }
  if (!isClaudeCodeClient(userAgent)) {
    return false;
  }
  if (!providerSupportsCaching(targetProvider, targetFormat)) {
    return false;
  }
  if (!isCombo) {
    return true;
  }
  return isDeterministicStrategy(comboStrategy);
}
function trackCacheMetrics({
  preserved,
  provider,
  strategy,
  metrics,
  inputTokens,
  cachedTokens,
  cacheCreationTokens
}) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  if (!metrics) {
    metrics = {
      totalRequests: 0,
      requestsWithCacheControl: 0,
      totalInputTokens: 0,
      totalCachedTokens: 0,
      totalCacheCreationTokens: 0,
      tokensSaved: 0,
      estimatedCostSaved: 0,
      byProvider: {},
      byStrategy: {},
      lastUpdated: now
    };
  }
  metrics.totalRequests++;
  const input = inputTokens || 0;
  const cached = cachedTokens || 0;
  const creation = cacheCreationTokens || 0;
  metrics.totalInputTokens += input;
  metrics.totalCachedTokens += cached;
  metrics.totalCacheCreationTokens += creation;
  if (cached > 0) {
    metrics.tokensSaved += cached;
  }
  if (preserved) {
    metrics.requestsWithCacheControl++;
    if (!metrics.byProvider[provider]) {
      metrics.byProvider[provider] = {
        requests: 0,
        inputTokens: 0,
        cachedTokens: 0,
        cacheCreationTokens: 0
      };
    }
    metrics.byProvider[provider].requests++;
    metrics.byProvider[provider].inputTokens += input;
    metrics.byProvider[provider].cachedTokens += cached;
    metrics.byProvider[provider].cacheCreationTokens += creation;
    if (strategy && !metrics.byStrategy[strategy]) {
      metrics.byStrategy[strategy] = {
        requests: 0,
        inputTokens: 0,
        cachedTokens: 0,
        cacheCreationTokens: 0
      };
    }
    if (strategy) {
      metrics.byStrategy[strategy].requests++;
      metrics.byStrategy[strategy].inputTokens += input;
      metrics.byStrategy[strategy].cachedTokens += cached;
      metrics.byStrategy[strategy].cacheCreationTokens += creation;
    }
  }
  metrics.lastUpdated = now;
  return metrics;
}
function updateCacheTokenMetrics({
  metrics,
  provider,
  strategy,
  inputTokens,
  cachedTokens,
  cacheCreationTokens,
  costSaved
}) {
  metrics.totalCachedTokens += cachedTokens;
  metrics.totalCacheCreationTokens += cacheCreationTokens;
  metrics.totalInputTokens += inputTokens;
  metrics.tokensSaved += cachedTokens;
  if (costSaved !== void 0) {
    metrics.estimatedCostSaved += costSaved;
  }
  if (metrics.byProvider[provider]) {
    metrics.byProvider[provider].cachedTokens += cachedTokens;
    metrics.byProvider[provider].cacheCreationTokens += cacheCreationTokens;
    metrics.byProvider[provider].inputTokens += inputTokens;
  }
  if (strategy && metrics.byStrategy[strategy]) {
    metrics.byStrategy[strategy].cachedTokens += cachedTokens;
    metrics.byStrategy[strategy].cacheCreationTokens += cacheCreationTokens;
    metrics.byStrategy[strategy].inputTokens += inputTokens;
  }
  metrics.lastUpdated = (/* @__PURE__ */ new Date()).toISOString();
  return metrics;
}
export {
  isClaudeCodeClient,
  isDeterministicStrategy,
  providerHonorsOpenAIFormatCacheControl,
  providerSupportsCaching,
  shouldPreserveCacheControl,
  trackCacheMetrics,
  updateCacheTokenMetrics
};
