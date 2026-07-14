const BUILT_IN_ALIASES = {
  // Gemini legacy → current
  "gemini-pro": "gemini-2.5-pro",
  "gemini-pro-vision": "gemini-2.5-pro",
  "gemini-1.5-pro": "gemini-2.5-pro",
  "gemini-1.5-flash": "gemini-2.5-flash",
  "gemini-1.0-pro": "gemini-2.5-pro",
  "gemini-2.0-flash": "gemini-2.5-flash",
  "gemini-2.0-flash-lite": "gemini-3.1-flash-lite",
  "gemini-3.1-flash-lite-preview": "gemini-3.1-flash-lite",
  "gemini-3-pro-high": "gemini-3.1-pro-high",
  "gemini-3-pro-low": "gemini-3.1-pro-low",
  // Retired free Gemma (was in the gemini-free pool) → current gemini-free model
  "gemma-4": "gemini-3.1-flash-lite",
  // Claude legacy → current
  "claude-3-opus-20240229": "claude-opus-4-20250514",
  "claude-3-sonnet-20240229": "claude-sonnet-4-20250514",
  "claude-3-haiku-20240307": "claude-3-5-sonnet-20241022",
  "claude-3-5-sonnet-latest": "claude-sonnet-4-20250514",
  "claude-3-5-haiku-latest": "claude-3-5-sonnet-20241022",
  // OpenAI legacy → current
  "gpt-4-turbo-preview": "gpt-4-turbo",
  "gpt-4-0125-preview": "gpt-4-turbo",
  "gpt-4-1106-preview": "gpt-4-turbo",
  "gpt-3.5-turbo-0125": "gpt-3.5-turbo",
  // Kimi/Moonshot — Fireworks long-path aliases (#265)
  "accounts/fireworks/models/kimi-k2p5": "moonshotai/Kimi-K2.5",
  "fireworks/accounts/fireworks/models/kimi-k2p5": "moonshotai/Kimi-K2.5",
  "kimi-k2p5": "moonshotai/Kimi-K2.5",
  "accounts/fireworks/models/kimi-k2": "moonshotai/Kimi-K2",
  "fireworks/accounts/fireworks/models/kimi-k2": "moonshotai/Kimi-K2",
  "kimi-k2": "moonshotai/Kimi-K2",
  // Mistral short aliases
  "mistral-large": "mistral-large-latest",
  "mistral-small": "mistral-small-latest",
  codestral: "codestral-latest",
  // Sweep 2026-06-19: codestral-2405 retired 2025-06-16 — forward to the current stable.
  "codestral-2405": "codestral-2508",
  // Llama short aliases
  "llama-3.3": "llama-3.3-70b-versatile",
  "llama-3-70b": "llama-3.3-70b-versatile",
  "llama-3-8b": "llama3-8b-8192"
};
const CUSTOM_ALIASES_GLOBAL_KEY = "__omniroute_customAliases__";
const _aliasStore = globalThis;
function customAliases() {
  if (!_aliasStore[CUSTOM_ALIASES_GLOBAL_KEY]) {
    _aliasStore[CUSTOM_ALIASES_GLOBAL_KEY] = {};
  }
  return _aliasStore[CUSTOM_ALIASES_GLOBAL_KEY];
}
function setCustomAliases(aliases) {
  _aliasStore[CUSTOM_ALIASES_GLOBAL_KEY] = { ...aliases };
}
function getCustomAliases() {
  return { ...customAliases() };
}
function getAllAliases() {
  return { ...BUILT_IN_ALIASES, ...customAliases() };
}
function resolveModelAlias(modelId) {
  if (!modelId) return modelId;
  const custom = customAliases();
  if (custom[modelId]) return custom[modelId];
  if (BUILT_IN_ALIASES[modelId]) return BUILT_IN_ALIASES[modelId];
  return modelId;
}
function getDeprecationNotice(modelId) {
  if (!modelId) return null;
  const resolved = resolveModelAlias(modelId);
  if (resolved === modelId) return null;
  return `Model "${modelId}" is deprecated. Forwarding to "${resolved}".`;
}
function isDeprecated(modelId) {
  return getDeprecationNotice(modelId) !== null;
}
function addCustomAlias(from, to) {
  customAliases()[from] = to;
}
function removeCustomAlias(from) {
  const custom = customAliases();
  if (custom[from]) {
    delete custom[from];
    return true;
  }
  return false;
}
function getBuiltInAliases() {
  return { ...BUILT_IN_ALIASES };
}
export {
  addCustomAlias,
  getAllAliases,
  getBuiltInAliases,
  getCustomAliases,
  getDeprecationNotice,
  isDeprecated,
  removeCustomAlias,
  resolveModelAlias,
  setCustomAliases
};
