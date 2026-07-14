import { estimateCompressionTokens } from "../services/compression/stats.ts";
function scopeMatches(grantedScope, requiredScope) {
  if (grantedScope === "*" || grantedScope === requiredScope) {
    return true;
  }
  if (grantedScope.endsWith("*")) {
    const prefix = grantedScope.slice(0, -1);
    return requiredScope.startsWith(prefix);
  }
  return false;
}
function scopeIntersects(toolScopes, allowScopes) {
  for (const ts of toolScopes) {
    for (const as of allowScopes) {
      if (scopeMatches(as, ts)) {
        return true;
      }
    }
  }
  return false;
}
function filterEntries(entries, profile) {
  const allowScopes = profile.allowScopes ?? [];
  const allowTools = profile.allowTools ?? [];
  const denyTools = profile.denyTools ?? [];
  const denySet = new Set(denyTools);
  const allowToolSet = new Set(allowTools);
  const hasFilter = allowScopes.length > 0 || allowTools.length > 0;
  const filtered = entries.filter((entry) => {
    if (denySet.has(entry.name)) return false;
    if (!hasFilter) return true;
    if (allowToolSet.has(entry.name)) return true;
    if (allowScopes.length > 0 && (entry.scopes?.length ?? 0) > 0) {
      return scopeIntersects(entry.scopes, allowScopes);
    }
    return false;
  });
  const max = profile.maxTools;
  if (max === void 0 || max < 0 || filtered.length <= max) {
    return filtered;
  }
  const prioritised = filtered.filter((e) => allowToolSet.has(e.name)).sort((a, b) => a.name.localeCompare(b.name));
  const rest = filtered.filter((e) => !allowToolSet.has(e.name)).sort((a, b) => a.name.localeCompare(b.name));
  return [...prioritised, ...rest].slice(0, max);
}
function reduceToolManifest(manifest, profile) {
  if (Array.isArray(manifest)) {
    return filterEntries(manifest, profile);
  }
  const entries = Object.values(manifest);
  const filtered = filterEntries(entries, profile);
  return Object.fromEntries(filtered.map((e) => [e.name, e]));
}
function estimateManifestTokens(manifest) {
  const entries = Array.isArray(manifest) ? manifest : Object.values(manifest);
  if (entries.length === 0) return 0;
  return entries.reduce((sum, entry) => {
    const nameTokens = estimateCompressionTokens(entry.name);
    const descTokens = estimateCompressionTokens(entry.description ?? "");
    return sum + nameTokens + descTokens;
  }, 0);
}
function readMcpToolProfileFromEnv(env) {
  const parse = (value) => value ? value.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const denyTools = parse(env["MCP_TOOL_DENY"]);
  const allowTools = parse(env["MCP_TOOL_ALLOW"]);
  if (denyTools.length === 0 && allowTools.length === 0) return null;
  return {
    name: "env",
    ...denyTools.length > 0 ? { denyTools } : {},
    ...allowTools.length > 0 ? { allowTools } : {}
  };
}
export {
  estimateManifestTokens,
  readMcpToolProfileFromEnv,
  reduceToolManifest
};
