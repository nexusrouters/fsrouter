/**
 * Rate-limit header parsing — extracted from rateLimitManager for modularity.
 * TODO: Wire to actual header constants from upstream providers.
 */

export const STANDARD_HEADERS = {
  limit: 'x-ratelimit-limit-requests',
  remaining: 'x-ratelimit-remaining-requests',
  reset: 'x-ratelimit-reset-requests',
  retryAfter: 'retry-after',
  overLimit: 'x-ratelimit-over-limit',
};

export const ANTHROPIC_HEADERS = {
  limit: 'anthropic-ratelimit-requests-limit',
  remaining: 'anthropic-ratelimit-requests-remaining',
  reset: 'anthropic-ratelimit-requests-reset',
  retryAfter: 'retry-after',
  overLimit: 'x-ratelimit-over-limit',
};

/**
 * Parse a reset time header value to milliseconds.
 * Handles both seconds (numeric) and ISO date strings.
 */
export function parseResetTime(value) {
  if (!value) return 0;
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) {
    // If it's a small number, treat as seconds; large numbers are epoch ms
    return num < 1e12 ? num * 1000 : num - Date.now();
  }
  // Try as ISO date
  const ms = Date.parse(value);
  if (Number.isFinite(ms) && ms > Date.now()) return ms - Date.now();
  return 0;
}

/**
 * Convert a Headers object or plain object to a lowercase-keyed plain object.
 */
export function toPlainHeaders(headers) {
  if (!headers) return {};
  if (typeof headers.entries === 'function') {
    const result = {};
    for (const [key, value] of headers.entries()) {
      result[key.toLowerCase()] = value;
    }
    return result;
  }
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key.toLowerCase()] = value;
  }
  return result;
}
