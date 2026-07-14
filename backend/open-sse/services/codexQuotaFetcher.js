import {
  CODEX_SPARK_QUOTA_SESSION,
  CODEX_SPARK_QUOTA_WEEKLY,
  getCodexModelScope,
  isCodexSparkLimitDescriptor
} from "../config/codexQuotaScopes.js";
import { registerQuotaFetcher, registerQuotaWindows } from "./quotaPreflight.js";
import { registerMonitorFetcher } from "./quotaMonitor.js";
import { throttleQuotaFetch } from "./quotaFetchThrottle.js";
const CODEX_WINDOW_SESSION = "session";
const CODEX_WINDOW_WEEKLY = "weekly";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CACHE_TTL_MS = 6e4;
const quotaCache = /* @__PURE__ */ new Map();
const _cacheCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of quotaCache) {
    if (now - entry.fetchedAt > CACHE_TTL_MS * 5) {
      quotaCache.delete(key);
    }
  }
}, 5 * 6e4);
if (typeof _cacheCleanup === "object" && "unref" in _cacheCleanup) {
  _cacheCleanup.unref?.();
}
const MAX_CONNECTIONS = 100;
const connectionRegistry = /* @__PURE__ */ new Map();
const MAX_QUOTA_CACHE_ENTRIES = 200;
function registerCodexConnection(connectionId, meta) {
  if (!connectionRegistry.has(connectionId) && connectionRegistry.size >= MAX_CONNECTIONS) {
    const oldestKey = connectionRegistry.keys().next().value;
    if (oldestKey !== void 0) {
      deleteQuotaCacheForConnection(oldestKey);
      connectionRegistry.delete(oldestKey);
    }
  }
  connectionRegistry.set(connectionId, meta);
}
function getQuotaCacheKey(connectionId, requestedModel) {
  return `${connectionId}:${getCodexModelScope(requestedModel)}`;
}
function deleteQuotaCacheForConnection(connectionId) {
  quotaCache.delete(connectionId);
  const scopedKeys = Array.from(quotaCache.keys()).filter(
    (key) => key.startsWith(`${connectionId}:`)
  );
  for (const key of scopedKeys) quotaCache.delete(key);
}
function unregisterCodexConnection(connectionId) {
  deleteQuotaCacheForConnection(connectionId);
  connectionRegistry.delete(connectionId);
}
function getRequestedModel(connection) {
  if (!connection || typeof connection !== "object") return null;
  const directModel = connection.requestedModel ?? connection.model;
  return typeof directModel === "string" && directModel.trim().length > 0 ? directModel.trim() : null;
}
function getCodexConnectionMeta(connectionId, connection) {
  if (connection && typeof connection === "object") {
    const providerSpecificData = connection.providerSpecificData && typeof connection.providerSpecificData === "object" && !Array.isArray(connection.providerSpecificData) ? connection.providerSpecificData : {};
    const accessToken = typeof connection.accessToken === "string" && connection.accessToken.trim().length > 0 ? connection.accessToken : null;
    const workspaceId = typeof providerSpecificData.workspaceId === "string" && providerSpecificData.workspaceId.trim().length > 0 ? providerSpecificData.workspaceId : void 0;
    if (accessToken) {
      const meta = { accessToken, ...workspaceId ? { workspaceId } : {} };
      if (!connectionRegistry.has(connectionId) && connectionRegistry.size >= MAX_CONNECTIONS) {
        const oldestKey = connectionRegistry.keys().next().value;
        if (oldestKey !== void 0) {
          deleteQuotaCacheForConnection(oldestKey);
          connectionRegistry.delete(oldestKey);
        }
      }
      connectionRegistry.set(connectionId, meta);
      return meta;
    }
  }
  return connectionRegistry.get(connectionId) || null;
}
function getDominantResetAt(quota) {
  if (quota.window7d.percentUsed > quota.window5h.percentUsed) {
    return quota.window7d.resetAt || quota.window5h.resetAt;
  }
  if (quota.window5h.percentUsed > quota.window7d.percentUsed) {
    return quota.window5h.resetAt || quota.window7d.resetAt;
  }
  return quota.window7d.resetAt || quota.window5h.resetAt;
}
async function fetchCodexQuota(connectionId, connection) {
  const requestedModel = getRequestedModel(connection);
  const cacheKey = getQuotaCacheKey(connectionId, requestedModel);
  const cached = quotaCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.quota;
  }
  const meta = getCodexConnectionMeta(connectionId, connection);
  if (!meta?.accessToken) {
    return null;
  }
  try {
    const headers = {
      Authorization: `Bearer ${meta.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    };
    if (meta.workspaceId) {
      headers["chatgpt-account-id"] = meta.workspaceId;
    }
    await throttleQuotaFetch();
    const response = await fetch(CODEX_USAGE_URL, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(8e3)
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        deleteQuotaCacheForConnection(connectionId);
        connectionRegistry.delete(connectionId);
      }
      return null;
    }
    const data = await response.json();
    const quota = parseCodexUsageResponse(data, requestedModel);
    if (!quota) return null;
    if (!quotaCache.has(connectionId) && quotaCache.size >= MAX_QUOTA_CACHE_ENTRIES) {
      const oldestCacheKey = quotaCache.keys().next().value;
      if (oldestCacheKey !== void 0) quotaCache.delete(oldestCacheKey);
    }
    quotaCache.set(cacheKey, { quota, fetchedAt: Date.now() });
    return quota;
  } catch {
    return null;
  }
}
function toNumber(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}
function toRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function parseWindowReset(window) {
  const resetAt = toNumber(window["reset_at"] ?? window["resetAt"], 0);
  if (resetAt > 0) {
    return new Date(resetAt * 1e3).toISOString();
  }
  const resetAfterSeconds = toNumber(
    window["reset_after_seconds"] ?? window["resetAfterSeconds"],
    0
  );
  if (resetAfterSeconds > 0) {
    return new Date(Date.now() + resetAfterSeconds * 1e3).toISOString();
  }
  return null;
}
function parseCodexWindow(window) {
  if (!window || Object.keys(window).length === 0) return null;
  const percentUsed = toNumber(window["used_percent"] ?? window["usedPercent"], 0) / 100;
  return { percentUsed, resetAt: parseWindowReset(window) };
}
function parseBankedResetCredits(data) {
  const resetCredits = toRecord(data["rate_limit_reset_credits"] ?? data["rateLimitResetCredits"]);
  const availableCount = resetCredits["available_count"] ?? resetCredits["availableCount"];
  const count = toNumber(availableCount, NaN);
  return Number.isFinite(count) ? count : void 0;
}
function parseRateLimitReachedType(data) {
  const reachedType = data["rate_limit_reached_type"] ?? data["rateLimitReachedType"];
  if (typeof reachedType === "string" && reachedType.trim().length > 0) return reachedType.trim();
  const reachedTypeObj = toRecord(reachedType);
  const type = reachedTypeObj["type"];
  return typeof type === "string" && type.trim().length > 0 ? type.trim() : void 0;
}
function findSparkRateLimit(data) {
  const additional = data["additional_rate_limits"] ?? data["additionalRateLimits"];
  if (!Array.isArray(additional)) return null;
  for (const entryValue of additional) {
    const entry = toRecord(entryValue);
    if (!isCodexSparkLimitDescriptor(
      entry["limit_name"],
      entry["limitName"],
      entry["metered_feature"],
      entry["meteredFeature"],
      entry["limit_id"],
      entry["limitId"],
      entry["id"],
      entry["name"],
      entry["title"],
      entry["model"],
      entry["model_id"],
      entry["modelId"]
    )) {
      continue;
    }
    return toRecord(entry["rate_limit"] ?? entry["rateLimit"]);
  }
  return null;
}
function getCodexRateLimitWindows(rateLimit) {
  return {
    primary: parseCodexWindow(toRecord(rateLimit["primary_window"] ?? rateLimit["primaryWindow"])),
    secondary: parseCodexWindow(
      toRecord(rateLimit["secondary_window"] ?? rateLimit["secondaryWindow"])
    )
  };
}
function assignCodexWindows(target, rateLimit, names) {
  const { primary, secondary } = getCodexRateLimitWindows(rateLimit);
  if (primary) target[names.primary] = primary;
  if (secondary) target[names.secondary] = secondary;
}
function getSelectedCodexRateLimit(normalRateLimit, sparkRateLimit, useSparkWindows) {
  if (useSparkWindows) return sparkRateLimit;
  return normalRateLimit;
}
function parseCodexUsageResponse(data, requestedModel) {
  const obj = toRecord(data);
  const normalRateLimit = toRecord(obj["rate_limit"] ?? obj["rateLimit"]);
  const sparkRateLimit = findSparkRateLimit(obj);
  const useSparkWindows = getCodexModelScope(requestedModel) === "spark";
  const selectedRateLimit = getSelectedCodexRateLimit(
    normalRateLimit,
    sparkRateLimit,
    useSparkWindows
  );
  if (!selectedRateLimit) return null;
  const { primary: parsedPrimary, secondary: parsedSecondary } = getCodexRateLimitWindows(selectedRateLimit);
  if (!parsedPrimary && !parsedSecondary) return null;
  const window5h = parsedPrimary ?? { percentUsed: 0, resetAt: null };
  const window7d = parsedSecondary ?? { percentUsed: 0, resetAt: null };
  const worstPercentUsed = Math.max(window5h.percentUsed, window7d.percentUsed);
  const limitReached = Boolean(
    selectedRateLimit["limit_reached"] ?? selectedRateLimit["limitReached"]
  );
  const windows = {};
  assignCodexWindows(windows, selectedRateLimit, {
    primary: useSparkWindows ? CODEX_SPARK_QUOTA_SESSION : CODEX_WINDOW_SESSION,
    secondary: useSparkWindows ? CODEX_SPARK_QUOTA_WEEKLY : CODEX_WINDOW_WEEKLY
  });
  const allWindows = {
    ...windows
  };
  if (sparkRateLimit) {
    assignCodexWindows(allWindows, sparkRateLimit, {
      primary: CODEX_SPARK_QUOTA_SESSION,
      secondary: CODEX_SPARK_QUOTA_WEEKLY
    });
  }
  assignCodexWindows(allWindows, normalRateLimit, {
    primary: CODEX_WINDOW_SESSION,
    secondary: CODEX_WINDOW_WEEKLY
  });
  const bankedResetCredits = parseBankedResetCredits(obj);
  const rateLimitReachedType = parseRateLimitReachedType(obj);
  return {
    used: Math.round(worstPercentUsed * 100),
    total: 100,
    percentUsed: worstPercentUsed,
    resetAt: getDominantResetAt({ window5h, window7d }),
    // Per-window breakdown for the preflight evaluator. For Spark requests this
    // intentionally contains ONLY Spark windows, so Spark exhaustion does not
    // preflight-block normal Codex requests (and vice versa).
    windows,
    allWindows,
    // Legacy fields preserved for existing consumers (quotaMonitor, cooldown
    // computation in accountFallback). These mirror the selected scope entries
    // but keep the historical names — do not remove without checking callers.
    window5h,
    window7d,
    limitReached,
    // Banked reset credits (display-only, eligibility-gated — issue #5199).
    ...bankedResetCredits !== void 0 ? { bankedResetCredits } : {},
    ...rateLimitReachedType !== void 0 ? { rateLimitReachedType } : {}
  };
}
function getCodexQuotaCooldownMs(quota, threshold = 0.95) {
  const now = Date.now();
  if (quota.window7d.percentUsed >= threshold && quota.window7d.resetAt) {
    const resetTime = new Date(quota.window7d.resetAt).getTime();
    if (resetTime > now) return resetTime - now;
  }
  if (quota.window5h.percentUsed >= threshold && quota.window5h.resetAt) {
    const resetTime = new Date(quota.window5h.resetAt).getTime();
    if (resetTime > now) return resetTime - now;
  }
  return 0;
}
function invalidateCodexQuotaCache(connectionId) {
  deleteQuotaCacheForConnection(connectionId);
}
function registerCodexQuotaFetcher() {
  registerQuotaFetcher("codex", fetchCodexQuota);
  registerMonitorFetcher("codex", fetchCodexQuota);
  registerQuotaWindows("codex", [
    CODEX_WINDOW_SESSION,
    CODEX_WINDOW_WEEKLY,
    CODEX_SPARK_QUOTA_SESSION,
    CODEX_SPARK_QUOTA_WEEKLY
  ]);
}
export {
  CODEX_WINDOW_SESSION,
  CODEX_WINDOW_WEEKLY,
  fetchCodexQuota,
  getCodexQuotaCooldownMs,
  invalidateCodexQuotaCache,
  registerCodexConnection,
  registerCodexQuotaFetcher,
  unregisterCodexConnection
};
