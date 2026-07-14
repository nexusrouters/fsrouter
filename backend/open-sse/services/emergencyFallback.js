import { isFeatureFlagEnabled } from "@/shared/utils/featureFlags";
const EMERGENCY_FALLBACK_FLAG_KEY = "OMNIROUTE_EMERGENCY_FALLBACK";
const EMERGENCY_FALLBACK_FLAG_CACHE_MS = 500;
let emergencyFallbackFlagCache = null;
let emergencyFallbackFeatureFlagResolver = isFeatureFlagEnabled;
const EMERGENCY_FALLBACK_CONFIG = {
  enabled: true,
  provider: "nvidia",
  model: "openai/gpt-oss-120b",
  triggerOn402: true,
  triggerOnBudgetKeywords: true,
  budgetKeywords: [
    "insufficient funds",
    "insufficient_funds",
    "budget exceeded",
    "budget_exceeded",
    "quota exceeded",
    "quota_exceeded",
    "billing",
    "payment required",
    "out of credits",
    "no credits",
    "credit limit",
    "spending limit",
    "saldo insuficiente",
    "limite de gastos",
    "cota excedida"
  ],
  skipForToolRequests: true,
  maxOutputTokens: 4096
};
function isEmergencyFallbackRawEnvEnabled() {
  const raw = process.env.OMNIROUTE_EMERGENCY_FALLBACK;
  return raw !== "false" && raw !== "0";
}
function resetEmergencyFallbackEnvCache() {
  emergencyFallbackFlagCache = null;
}
function setEmergencyFallbackFeatureFlagResolverForTest(resolver) {
  emergencyFallbackFeatureFlagResolver = resolver ?? isFeatureFlagEnabled;
  resetEmergencyFallbackEnvCache();
}
function isEmergencyFallbackEnvEnabled() {
  const now = Date.now();
  if (emergencyFallbackFlagCache && emergencyFallbackFlagCache.expiresAt > now) {
    return emergencyFallbackFlagCache.value;
  }
  let value;
  try {
    value = emergencyFallbackFeatureFlagResolver(EMERGENCY_FALLBACK_FLAG_KEY);
  } catch (error) {
    console.warn(
      "[emergencyFallback] Feature flag resolution failed; falling back to raw env:",
      error instanceof Error ? error.message : error
    );
    value = isEmergencyFallbackRawEnvEnabled();
  }
  emergencyFallbackFlagCache = {
    value,
    expiresAt: now + EMERGENCY_FALLBACK_FLAG_CACHE_MS
  };
  return value;
}
function shouldUseFallback(status, errorBody, requestHasTools, config = EMERGENCY_FALLBACK_CONFIG) {
  if (!config.enabled) return { shouldFallback: false, reason: "emergency fallback disabled" };
  if (!isEmergencyFallbackEnvEnabled()) {
    return {
      shouldFallback: false,
      reason: "emergency fallback disabled via OMNIROUTE_EMERGENCY_FALLBACK"
    };
  }
  if (config.skipForToolRequests && requestHasTools) {
    return { shouldFallback: false, reason: "skipped: request has tools" };
  }
  if (config.triggerOn402 && status === 402) {
    return {
      shouldFallback: true,
      reason: `HTTP 402 \u2192 emergency fallback to ${config.provider}/${config.model}`,
      provider: config.provider,
      model: config.model,
      maxOutputTokens: config.maxOutputTokens
    };
  }
  if (config.triggerOnBudgetKeywords && errorBody) {
    const lowerBody = errorBody.toLowerCase();
    const matched = config.budgetKeywords.find((kw) => lowerBody.includes(kw.toLowerCase()));
    if (matched) {
      return {
        shouldFallback: true,
        reason: `Budget error detected ('${matched}') \u2192 emergency fallback to ${config.provider}/${config.model}`,
        provider: config.provider,
        model: config.model,
        maxOutputTokens: config.maxOutputTokens
      };
    }
  }
  return { shouldFallback: false, reason: "no budget error detected" };
}
function isFallbackDecision(result) {
  return result.shouldFallback === true;
}
export {
  EMERGENCY_FALLBACK_CONFIG,
  isEmergencyFallbackEnvEnabled,
  isFallbackDecision,
  resetEmergencyFallbackEnvCache,
  setEmergencyFallbackFeatureFlagResolverForTest,
  shouldUseFallback
};
