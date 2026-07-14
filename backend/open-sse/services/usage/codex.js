/**
 * Codex (OpenAI / ChatGPT backend) usage handler
 * Updated from OmniRoute — supports dual-window quota, code_review, spark, bankedResetCredits
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";

// Codex (OpenAI) API config — uses /wham/usage (newer endpoint)
const CODEX_CONFIG = {
  usageUrl: "https://chatgpt.com/backend-api/wham/usage",
};

function getFieldValue(record, ...keys) {
  if (!record || typeof record !== "object") return null;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return null;
}

function toRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toNumber(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function parseResetTime(resetValue) {
  if (!resetValue) return null;
  try {
    let date = null;
    if (resetValue instanceof Date) {
      date = resetValue;
    } else if (typeof resetValue === "number") {
      date = new Date(resetValue < 1e12 ? resetValue * 1000 : resetValue);
    } else if (typeof resetValue === "string") {
      if (/^\d+$/.test(resetValue)) {
        const ts = Number(resetValue);
        date = new Date(ts < 1e12 ? ts * 1000 : ts);
      } else {
        date = new Date(resetValue);
      }
    }
    if (!date || date.getTime() <= 0) return null;
    return date.toISOString();
  } catch {
    return null;
  }
}

function parseWindowReset(window) {
  const resetAt = toNumber(getFieldValue(window, "reset_at", "resetAt"), 0);
  const resetAfterSeconds = toNumber(getFieldValue(window, "reset_after_seconds", "resetAfterSeconds"), 0);
  if (resetAt > 0) return parseResetTime(resetAt * 1000);
  if (resetAfterSeconds > 0) return parseResetTime(Date.now() + resetAfterSeconds * 1000);
  return null;
}

function buildPercentageQuota(window, displayName) {
  const usedPercent = toNumber(getFieldValue(window, "used_percent", "usedPercent"), 0);
  return {
    used: usedPercent,
    total: 100,
    remaining: 100 - usedPercent,
    resetAt: parseWindowReset(window),
    unlimited: false,
    ...(displayName ? { displayName } : {}),
  };
}

function isCodexReviewLimitDescriptor(...values) {
  return values.some((value) => {
    if (typeof value !== "string") return false;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return false;
    return (
      normalized === "code_review" ||
      normalized === "codex_review" ||
      normalized === "review" ||
      normalized.includes("code_review") ||
      normalized.includes("codex_review") ||
      normalized.includes("code review")
    );
  });
}

function findCodexReviewRateLimit(data) {
  const additionalRateLimits = getFieldValue(data, "additional_rate_limits", "additionalRateLimits");
  if (!Array.isArray(additionalRateLimits)) return {};
  for (const entry of additionalRateLimits) {
    const rec = toRecord(entry);
    if (
      isCodexReviewLimitDescriptor(
        getFieldValue(rec, "limit_name", "limitName"),
        getFieldValue(rec, "metered_feature", "meteredFeature"),
        getFieldValue(rec, "limit_id", "limitId"),
        rec["id"], rec["name"]
      )
    ) {
      return toRecord(getFieldValue(rec, "rate_limit", "rateLimit"));
    }
  }
  return {};
}

function isCodexSparkLimitDescriptor(...values) {
  return values.some((value) => {
    if (typeof value !== "string") return false;
    const normalized = value.trim().toLowerCase();
    return normalized === "spark" || normalized.includes("spark");
  });
}

function findCodexSparkRateLimit(data) {
  const additionalRateLimits = getFieldValue(data, "additional_rate_limits", "additionalRateLimits");
  if (!Array.isArray(additionalRateLimits)) return {};
  for (const entry of additionalRateLimits) {
    const rec = toRecord(entry);
    if (
      isCodexSparkLimitDescriptor(
        getFieldValue(rec, "limit_name", "limitName"),
        getFieldValue(rec, "metered_feature", "meteredFeature"),
        getFieldValue(rec, "limit_id", "limitId"),
        rec["id"], rec["name"], rec["model"],
        getFieldValue(rec, "model_id", "modelId")
      )
    ) {
      return toRecord(getFieldValue(rec, "rate_limit", "rateLimit"));
    }
  }
  return {};
}

function parseBankedResetCredits(data) {
  const resetCredits = toRecord(getFieldValue(data, "rate_limit_reset_credits", "rateLimitResetCredits"));
  const availableCount = getFieldValue(resetCredits, "available_count", "availableCount");
  const count = toNumber(availableCount, NaN);
  return Number.isFinite(count) ? count : undefined;
}

function parseRateLimitReachedType(data) {
  const reachedType = getFieldValue(data, "rate_limit_reached_type", "rateLimitReachedType");
  if (typeof reachedType === "string" && reachedType.trim().length > 0) return reachedType.trim();
  const reachedTypeObj = toRecord(reachedType);
  const type = getFieldValue(reachedTypeObj, "type");
  return typeof type === "string" && type.trim().length > 0 ? type.trim() : undefined;
}

/**
 * Build Codex usage quotas from /wham/usage response.
 * Supports: session (5h), weekly (7d), code_review, code_review_weekly, spark, spark_weekly
 */
function buildCodexUsageQuotas(dataValue) {
  const data = toRecord(dataValue);
  const rateLimit = toRecord(getFieldValue(data, "rate_limit", "rateLimit"));
  const quotas = {};
  const bankedResetCredits = parseBankedResetCredits(data);
  const rateLimitReachedType = parseRateLimitReachedType(data);

  // Primary window (5h session)
  const primaryWindow = toRecord(getFieldValue(rateLimit, "primary_window", "primaryWindow"));
  if (Object.keys(primaryWindow).length > 0) quotas.session = buildPercentageQuota(primaryWindow);

  // Secondary window (7d weekly)
  const secondaryWindow = toRecord(getFieldValue(rateLimit, "secondary_window", "secondaryWindow"));
  if (Object.keys(secondaryWindow).length > 0) quotas.weekly = buildPercentageQuota(secondaryWindow);

  // Code review rate limit (dedicated block or additional_rate_limits fallback)
  const dedicatedReviewRateLimit = toRecord(getFieldValue(data, "code_review_rate_limit", "codeReviewRateLimit"));
  const reviewRateLimit = Object.keys(dedicatedReviewRateLimit).length > 0
    ? dedicatedReviewRateLimit
    : findCodexReviewRateLimit(data);

  const codeReviewWindow = toRecord(getFieldValue(reviewRateLimit, "primary_window", "primaryWindow"));
  if (getFieldValue(codeReviewWindow, "used_percent", "usedPercent") !== null ||
      getFieldValue(codeReviewWindow, "remaining_count", "remainingCount") !== null) {
    quotas.code_review = buildPercentageQuota(codeReviewWindow);
  }

  const codeReviewSecondaryWindow = toRecord(getFieldValue(reviewRateLimit, "secondary_window", "secondaryWindow"));
  if (getFieldValue(codeReviewSecondaryWindow, "used_percent", "usedPercent") !== null ||
      getFieldValue(codeReviewSecondaryWindow, "remaining_count", "remainingCount") !== null) {
    quotas.code_review_weekly = buildPercentageQuota(codeReviewSecondaryWindow);
  }

  // Spark quota (additional_rate_limits)
  const sparkRateLimit = findCodexSparkRateLimit(data);
  const sparkPrimaryWindow = toRecord(getFieldValue(sparkRateLimit, "primary_window", "primaryWindow"));
  if (Object.keys(sparkPrimaryWindow).length > 0) {
    quotas.spark = buildPercentageQuota(sparkPrimaryWindow, "Spark");
  }
  const sparkSecondaryWindow = toRecord(getFieldValue(sparkRateLimit, "secondary_window", "secondaryWindow"));
  if (Object.keys(sparkSecondaryWindow).length > 0) {
    quotas.spark_weekly = buildPercentageQuota(sparkSecondaryWindow, "Spark Weekly");
  }

  return { rateLimit, quotas, bankedResetCredits, rateLimitReachedType };
}

/**
 * Codex (OpenAI) Usage - Fetch from ChatGPT /wham/usage API
 * Uses persisted workspaceId from OAuth for correct workspace binding.
 */
export async function getCodexUsage(accessToken, providerSpecificData = {}) {
  try {
    const accountId = typeof providerSpecificData?.workspaceId === "string"
      ? providerSpecificData.workspaceId
      : null;

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (accountId) {
      headers["chatgpt-account-id"] = accountId;
    }

    const response = await proxyAwareFetch(CODEX_CONFIG.usageUrl, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return {
          message: "Codex token expired or access denied. Please re-authenticate the connection.",
        };
      }
      throw new Error(`Codex API error: ${response.status}`);
    }

    const data = await response.json();
    const { rateLimit, quotas, bankedResetCredits, rateLimitReachedType } = buildCodexUsageQuotas(data);

    return {
      plan: String(getFieldValue(data, "plan_type", "planType") || "unknown"),
      limitReached: Boolean(getFieldValue(rateLimit, "limit_reached", "limitReached")),
      quotas,
      ...(bankedResetCredits !== undefined ? { bankedResetCredits } : {}),
      ...(rateLimitReachedType !== undefined ? { rateLimitReachedType } : {}),
    };
  } catch (error) {
    return { message: `Failed to fetch Codex usage: ${error.message}` };
  }
}

// Stub: consume a banked reset credit (display-only, not implemented in AMRouter)
export async function consumeCodexRateLimitResetCredit(accessToken, providerSpecificData = {}) {
  return { success: false, message: "Reset credit consumption not supported" };
}

// Stub: get banked reset credits
export async function getCodexRateLimitResetCredits(accessToken, providerSpecificData = {}) {
  try {
    const result = await getCodexUsage(accessToken, providerSpecificData);
    return { credits: result.bankedResetCredits || 0 };
  } catch {
    return { credits: 0 };
  }
}
