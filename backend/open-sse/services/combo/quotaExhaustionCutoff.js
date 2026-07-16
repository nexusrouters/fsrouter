import {
  evaluateQuotaCutoff,
  getQuotaFetcher
} from "../quotaPreflight.ts";
import { getProviderConnectionById } from '../../dist/lib/db/providers.js';
import {
  resolveResilienceSettings
} from '../../dist/lib/resilience/settings.js';
import { fetchResetAwareQuotaWithCache } from "./quotaStrategies.ts";
function asThresholdMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    const numeric = Number(raw);
    if (key && Number.isFinite(numeric)) result[key] = numeric;
  }
  return result;
}
function quotaWindowLookupNames(provider, windowName) {
  const names = [windowName];
  const lower = windowName.toLowerCase();
  if (lower !== windowName) names.push(lower);
  if (provider === "codex") {
    if (lower.includes("session") || lower === "5h" || lower === "five_hour") names.push("session");
    if (lower.includes("weekly") || lower === "7d" || lower === "seven_day") names.push("weekly");
    if (lower.includes("monthly") || lower === "30d") names.push("monthly");
  }
  return [...new Set(names)];
}
function buildAutoQuotaThresholds(provider, connection, resilienceSettings) {
  const quotaPreflight = (resilienceSettings ?? resolveResilienceSettings(null))?.quotaPreflight;
  const defaultThresholdPercent = quotaPreflight?.defaultThresholdPercent ?? 2;
  const warnThresholdPercent = quotaPreflight?.warnThresholdPercent ?? 20;
  const providerWindowMap = asThresholdMap(quotaPreflight?.providerWindowDefaults?.[provider]);
  const perConnectionWindowOverrides = asThresholdMap(connection?.quotaWindowThresholds);
  return {
    resolveMinRemainingPercent: (windowName) => {
      if (windowName !== null) {
        for (const lookupWindowName of quotaWindowLookupNames(provider, windowName)) {
          const override = perConnectionWindowOverrides[lookupWindowName];
          if (typeof override === "number") return override;
          const providerDefault = providerWindowMap[lookupWindowName];
          if (typeof providerDefault === "number") return providerDefault;
        }
      }
      return defaultThresholdPercent;
    },
    resolveWarnRemainingPercent: () => warnThresholdPercent
  };
}
async function resolveQuotaExhaustionCutoffForTarget(provider, connectionId, resilienceSettings, resetWindowConfig, comboName, log) {
  const quotaCutoffEnabled = (resilienceSettings ?? resolveResilienceSettings(null))?.quotaPreflight?.enabled === true;
  if (!quotaCutoffEnabled || !provider || !connectionId) return { blocked: false };
  const fetcher = getQuotaFetcher(provider);
  if (!fetcher) return { blocked: false };
  let connection;
  try {
    connection = await getProviderConnectionById(connectionId);
  } catch {
    connection = void 0;
  }
  try {
    const quota = await fetchResetAwareQuotaWithCache({
      provider,
      connectionId,
      connection,
      fetcher,
      config: resetWindowConfig,
      log,
      comboName
    });
    const cutoffDecision = evaluateQuotaCutoff(
      quota,
      buildAutoQuotaThresholds(provider, connection, resilienceSettings)
    );
    if (!cutoffDecision.proceed) {
      return { blocked: true, reason: cutoffDecision.reason || "quota_exhausted" };
    }
  } catch {
    return { blocked: false };
  }
  return { blocked: false };
}
export {
  buildAutoQuotaThresholds,
  resolveQuotaExhaustionCutoffForTarget
};
