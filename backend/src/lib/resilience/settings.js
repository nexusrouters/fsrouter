/**
 * Stub: resilience settings.
 * TODO: Wire to actual settings DB when available.
 */

export const DEFAULT_RESILIENCE_SETTINGS = {
  requestQueue: {
    requestsPerMinute: 0,
    concurrentRequests: 0,
    minTimeBetweenRequestsMs: 0,
    maxWaitMs: 0,
    autoEnableApiKeyProviders: true,
  },
  providerCooldown: {
    minRetryCooldownMs: 5000,
    maxRetryCooldownMs: 300000,
  },
  streamRecovery: {
    enabled: false,
    holdbackMs: 2000,
  },
};

export function resolveResilienceSettings(settings) {
  if (!settings || typeof settings !== 'object') return DEFAULT_RESILIENCE_SETTINGS;
  return {
    ...DEFAULT_RESILIENCE_SETTINGS,
    ...settings,
    requestQueue: {
      ...DEFAULT_RESILIENCE_SETTINGS.requestQueue,
      ...(settings.requestQueue || {}),
    },
    providerCooldown: {
      ...DEFAULT_RESILIENCE_SETTINGS.providerCooldown,
      ...(settings.providerCooldown || {}),
    },
  };
}
