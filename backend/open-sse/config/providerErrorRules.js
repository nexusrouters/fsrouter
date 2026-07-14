function buildOpencodeRules() {
  return [
    {
      id: "opencode-monthly-quota-resets-in",
      match: ({ status, body }) => {
        if (status !== 429) return null;
        const text = JSON.stringify(body ?? "").toLowerCase();
        if (!text.includes("monthly usage limit reached")) return null;
        const cooldownMs = parseResetCountdownMs(text);
        if (cooldownMs === null) return null;
        return {
          reason: "quota_exhausted",
          scope: "connection",
          cooldownMs
        };
      }
    },
    {
      id: "opencode-quota-exhausted-headers",
      match: ({ status, headers }) => {
        if (status !== 429) return null;
        const remainingRequests = headers["x-ratelimit-remaining-requests"];
        if (remainingRequests === "0") {
          return { reason: "quota_exhausted", scope: "connection" };
        }
        const remainingTokens = headers["x-ratelimit-remaining-tokens"];
        if (remainingTokens === "0") {
          return { reason: "quota_exhausted", scope: "connection" };
        }
        return null;
      }
    },
    {
      id: "opencode-quota-exhausted-body",
      match: ({ status, body }) => {
        if (status !== 429) return null;
        const text = JSON.stringify(body ?? "").toLowerCase();
        if (text.includes("organization_quota_exceeded") || text.includes("account_quota_exceeded") || text.includes("plan_limit_reached")) {
          return { reason: "quota_exhausted", scope: "connection" };
        }
        return null;
      }
    }
  ];
}
function buildMinimaxRules() {
  return [
    {
      id: "minimax-per-model-quota",
      match: ({ status, headers }) => {
        if (status !== 429) return null;
        const headerVal = headers["x-model-quota-remaining"];
        if (!headerVal) return null;
        const exhausted = headerVal.split(",").some((pair) => pair.split("=")[1]?.trim() === "0");
        if (exhausted) {
          return { reason: "quota_exhausted", scope: "model" };
        }
        return null;
      }
    }
  ];
}
const providerRuleRegistry = /* @__PURE__ */ new Map([
  ["opencode", buildOpencodeRules()],
  ["opencode-go", buildOpencodeRules()],
  ["opencode-cli", buildOpencodeRules()],
  ["minimax", buildMinimaxRules()],
  ["minimax-passthrough", buildMinimaxRules()]
]);
function getProviderErrorRuleMatch(provider, status, headers, body) {
  if (!provider) return null;
  const rules = providerRuleRegistry.get(provider.toLowerCase());
  if (!rules) return null;
  const safeHeaders = !headers ? {} : typeof headers.get === "function" ? Object.fromEntries(headers.entries()) : Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key.toLowerCase(),
      value
    ])
  );
  for (const rule of rules) {
    const match = rule.match({ status, headers: safeHeaders, body });
    if (match) return match;
  }
  return null;
}
function parseResetCountdownMs(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  const match = text.match(/resets?\s+in\s+(\d+)\s+(day|days|hour|hours|minute|minutes|second|seconds)\b/);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = match[2];
  switch (unit) {
    case "day":
    case "days":
      return n * 864e5;
    case "hour":
    case "hours":
      return n * 36e5;
    case "minute":
    case "minutes":
      return n * 6e4;
    case "second":
    case "seconds":
      return n * 1e3;
    default:
      return null;
  }
}
export {
  getProviderErrorRuleMatch,
  parseResetCountdownMs,
  providerRuleRegistry
};
