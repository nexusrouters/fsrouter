/**
 * Stub: provider default rate limit — sliding-window fallback for header-less providers.
 * TODO: Wire to actual PROVIDER_DEFAULT_RATE_LIMITS config when available.
 */

const PROVIDER_DEFAULT_RATE_LIMITS = {};

export async function awaitProviderDefaultSlot(provider, connectionId, signal, maxWaitMs) {
  // No-op unless PROVIDER_DEFAULT_RATE_LIMITS has an entry for this provider.
  return;
}
