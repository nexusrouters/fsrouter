/**
 * Stub: providerRegistry — provider category + registry lookups.
 * TODO: Wire to actual provider registry when available.
 */

export function getProviderCategory(provider) {
  const p = (provider || '').toLowerCase();
  // OAuth providers
  if (['codex', 'cursor', 'kiro', 'qoder', 'cline', 'opencode', 'grok'].includes(p)) return 'oauth';
  // Default to apikey
  return 'apikey';
}

export function getRegistryEntry(provider) {
  return null;
}
