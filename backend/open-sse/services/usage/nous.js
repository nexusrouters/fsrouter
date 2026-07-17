/**
 * Nous Research usage/quota fetcher.
 *
 * Nous Portal free tier (no credit card): 50 RPM, 500K TPM.
 * Nous does not expose a public per-account usage/quota API, so we surface the
 * published free-tier limits as a static quota entry. Requests count against
 * these limits and reset on a rolling window; without a live counter we report
 * the plan cap and leave `remaining` open (Infinity) so the UI shows the tier.
 *
 * @param {string} accessToken - OAuth Bearer token (unused for static tier info)
 * @returns {Promise<{quotas: Array, plan: string}>}
 */
export async function getNousUsage(accessToken) {
  void accessToken; // reserved for future live quota endpoint
  return {
    plan: "Free Tier (Nous Portal)",
    quotas: [
      {
        label: "Requests / min",
        total: 50,
        used: 0,
        remaining: 50,
        unit: "rpm",
        resetAt: null,
      },
      {
        label: "Tokens / min",
        total: 500000,
        used: 0,
        remaining: 500000,
        unit: "tpm",
        resetAt: null,
      },
    ],
  };
}
