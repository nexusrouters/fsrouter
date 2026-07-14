/**
 * Stub: feature flags utility.
 * TODO: Wire to actual feature flag system when available.
 */

export function isFeatureFlagEnabled(key) {
  if (!key) return true;
  const raw = process.env[key];
  if (raw === 'false' || raw === '0' || raw === 'off') return false;
  if (raw === 'true' || raw === '1' || raw === 'on') return true;
  return true; // Default enabled
}
