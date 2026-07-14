/**
 * Codex quota scope identifiers and helpers.
 * Matches OmniRoute codexQuotaScopes.ts — identifies Spark vs normal quota windows.
 */

export const CODEX_SPARK_QUOTA_SESSION = 'spark_session';
export const CODEX_SPARK_QUOTA_WEEKLY = 'spark_weekly';

/**
 * Determine the quota scope for a requested model.
 * Returns 'spark' for Spark-tier models, 'default' otherwise.
 */
export function getCodexModelScope(requestedModel) {
  if (!requestedModel || typeof requestedModel !== 'string') return 'default';
  const m = requestedModel.toLowerCase();
  // Spark models are free-tier / low-cost variants
  if (m.includes('spark') || m.includes('mini') || m.includes('nano')) return 'spark';
  return 'default';
}

/**
 * Check if a rate-limit descriptor matches a Codex Spark limit.
 */
export function isCodexSparkLimitDescriptor(
  limitName, limitNameAlt,
  meteredFeature, meteredFeatureAlt,
  limitId, limitIdAlt,
  id, name, title,
  model, modelId, modelIdAlt
) {
  const fields = [
    limitName, limitNameAlt,
    meteredFeature, meteredFeatureAlt,
    limitId, limitIdAlt,
    id, name, title,
    model, modelId, modelIdAlt,
  ];
  for (const f of fields) {
    if (typeof f === 'string' && f.toLowerCase().includes('spark')) return true;
  }
  return false;
}
