const ANTHROPIC_VERSION_HEADER = "2023-06-01";
const ANTHROPIC_BETA_BASE = Object.freeze([
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "advanced-tool-use-2025-11-20",
  "effort-2025-11-24",
  "structured-outputs-2025-12-15",
  "fast-mode-2026-02-01",
  "redact-thinking-2026-02-12",
  "token-efficient-tools-2026-03-28",
  "advisor-tool-2026-03-01",
  "extended-cache-ttl-2025-04-11",
  "cache-diagnosis-2026-04-07"
]);
const CLAUDE_OAUTH_EXTRA_BETAS = Object.freeze(["fine-grained-tool-streaming-2025-05-14"]);
const ANTHROPIC_BETA_FULL = ANTHROPIC_BETA_BASE.join(",");
const ANTHROPIC_BETA_API_KEY = ANTHROPIC_BETA_BASE.filter(
  (beta) => beta !== "oauth-2025-04-20"
).join(",");
const ANTHROPIC_BETA_CLAUDE_OAUTH = [
  ...ANTHROPIC_BETA_BASE.slice(0, 3),
  ...CLAUDE_OAUTH_EXTRA_BETAS,
  ...ANTHROPIC_BETA_BASE.slice(3)
].join(",");
const FORWARDABLE_CLIENT_BETAS = Object.freeze(["tool-search-tool-2025-10-19"]);
function mergeClientAnthropicBeta(base, clientBeta, allow = FORWARDABLE_CLIENT_BETAS) {
  const baseList = base.split(",").map((s) => s.trim()).filter(Boolean);
  if (typeof clientBeta !== "string" || !clientBeta.trim()) return baseList.join(",");
  const seen = new Set(baseList.map((s) => s.toLowerCase()));
  const allowSet = new Set(allow.map((s) => s.toLowerCase()));
  for (const token of clientBeta.split(",").map((s) => s.trim()).filter(Boolean)) {
    const lower = token.toLowerCase();
    if (allowSet.has(lower) && !seen.has(lower)) {
      baseList.push(token);
      seen.add(lower);
    }
  }
  return baseList.join(",");
}
function uniqueCommaValues(values) {
  return [
    ...new Set(
      values.filter((value) => value !== void 0 && value !== null && value !== "").flatMap((value) => String(value).split(",")).map((value) => value.trim()).filter(Boolean)
    )
  ];
}
function normalizeAnthropicHeaderVariants(headers) {
  if ("anthropic-version" in headers && "Anthropic-Version" in headers) {
    const versionValues = uniqueCommaValues([
      headers["anthropic-version"],
      headers["Anthropic-Version"]
    ]);
    delete headers["Anthropic-Version"];
    delete headers["anthropic-version"];
    if (versionValues.length > 0) {
      headers["anthropic-version"] = versionValues[0];
    }
  }
  if ("anthropic-beta" in headers && "Anthropic-Beta" in headers) {
    const betaValues = uniqueCommaValues([headers["anthropic-beta"], headers["Anthropic-Beta"]]);
    delete headers["Anthropic-Beta"];
    delete headers["anthropic-beta"];
    if (betaValues.length > 0) {
      headers["anthropic-beta"] = betaValues.join(",");
    }
  }
}
const CLAUDE_CLI_VERSION = "2.1.195";
const CLAUDE_CLI_USER_AGENT = `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`;
const CLAUDE_CLI_STAINLESS_PACKAGE_VERSION = "0.94.0";
const CLAUDE_CLI_STAINLESS_RUNTIME_VERSION = "v24.3.0";
export {
  ANTHROPIC_BETA_API_KEY,
  ANTHROPIC_BETA_CLAUDE_OAUTH,
  ANTHROPIC_BETA_FULL,
  ANTHROPIC_VERSION_HEADER,
  CLAUDE_CLI_STAINLESS_PACKAGE_VERSION,
  CLAUDE_CLI_STAINLESS_RUNTIME_VERSION,
  CLAUDE_CLI_USER_AGENT,
  CLAUDE_CLI_VERSION,
  FORWARDABLE_CLIENT_BETAS,
  mergeClientAnthropicBeta,
  normalizeAnthropicHeaderVariants
};
