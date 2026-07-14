import {
  DEFAULT_RESILIENCE_SETTINGS
} from "../../src/lib/resilience/settings";
const cooldownMap = /* @__PURE__ */ new Map();
const DEFAULT_ENTRY_RETENTION_MS = 30 * 60 * 1e3;
const CLEANUP_INTERVAL_MS = 60 * 1e3;
let cleanupTimer = null;
function startCleanupIfNeeded() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    cleanupExpiredCooldownEntries();
  }, CLEANUP_INTERVAL_MS);
  if (cleanupTimer.unref) cleanupTimer.unref();
}
function getEntryRetentionMs(settings) {
  const maxRetryCooldownMs = settings?.providerCooldown?.maxRetryCooldownMs ?? DEFAULT_RESILIENCE_SETTINGS.providerCooldown.maxRetryCooldownMs;
  return Math.max(DEFAULT_ENTRY_RETENTION_MS, maxRetryCooldownMs);
}
function cleanupExpiredCooldownEntries(now = Date.now()) {
  for (const [key, entry] of cooldownMap) {
    if (now - entry.lastFailureAt > entry.retentionMs) {
      cooldownMap.delete(key);
    }
  }
}
function cooldownKey(provider, connectionId) {
  return connectionId ? `${provider}:${connectionId}` : provider;
}
function recordProviderCooldown(provider, connectionId, settings) {
  if (!provider || provider === "unknown") return;
  const key = cooldownKey(provider, connectionId);
  const existing = cooldownMap.get(key);
  const now = Date.now();
  const retentionMs = getEntryRetentionMs(settings);
  if (existing) {
    existing.lastFailureAt = now;
    existing.failureCount++;
    existing.retentionMs = Math.max(existing.retentionMs, retentionMs);
  } else {
    cooldownMap.set(key, { lastFailureAt: now, failureCount: 1, retentionMs });
  }
  startCleanupIfNeeded();
}
function isProviderInCooldown(provider, connectionId, settings) {
  if (!provider || provider === "unknown") return false;
  const key = cooldownKey(provider, connectionId);
  const entry = cooldownMap.get(key);
  if (!entry) return false;
  if (entry.failureCount === 0) return false;
  const now = Date.now();
  const elapsed = now - entry.lastFailureAt;
  const minCooldownMs = settings?.providerCooldown?.minRetryCooldownMs ?? DEFAULT_RESILIENCE_SETTINGS.providerCooldown.minRetryCooldownMs;
  const maxCooldownMs = settings?.providerCooldown?.maxRetryCooldownMs ?? DEFAULT_RESILIENCE_SETTINGS.providerCooldown.maxRetryCooldownMs;
  const exponent = Math.min(Math.max(0, entry.failureCount - 1), 10);
  const scaledCooldownMs = Math.min(minCooldownMs * Math.pow(2, exponent), maxCooldownMs);
  return elapsed < scaledCooldownMs;
}
function getRemainingCooldownMs(provider, connectionId, settings) {
  if (!provider || provider === "unknown") return 0;
  const key = cooldownKey(provider, connectionId);
  const entry = cooldownMap.get(key);
  if (!entry) return 0;
  const now = Date.now();
  const elapsed = now - entry.lastFailureAt;
  const minCooldownMs = settings?.providerCooldown?.minRetryCooldownMs ?? DEFAULT_RESILIENCE_SETTINGS.providerCooldown.minRetryCooldownMs;
  const maxCooldownMs = settings?.providerCooldown?.maxRetryCooldownMs ?? DEFAULT_RESILIENCE_SETTINGS.providerCooldown.maxRetryCooldownMs;
  const exponent = Math.min(Math.max(0, entry.failureCount - 1), 10);
  const scaledCooldownMs = Math.min(minCooldownMs * Math.pow(2, exponent), maxCooldownMs);
  const remaining = scaledCooldownMs - elapsed;
  return remaining > 0 ? remaining : 0;
}
function recordProviderSuccess(provider, connectionId) {
  if (!provider || provider === "unknown") return;
  const key = cooldownKey(provider, connectionId);
  const entry = cooldownMap.get(key);
  if (entry) {
    entry.failureCount = 0;
  }
}
function clearCooldownState() {
  cooldownMap.clear();
}
function getCooldownEntryCount() {
  return cooldownMap.size;
}
export {
  cleanupExpiredCooldownEntries,
  clearCooldownState,
  getCooldownEntryCount,
  getRemainingCooldownMs,
  isProviderInCooldown,
  recordProviderCooldown,
  recordProviderSuccess
};
