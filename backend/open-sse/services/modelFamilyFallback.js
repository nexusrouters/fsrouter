import { getModelContextLimit } from "../../src/lib/modelCapabilities";
import { parseModel } from "./model.js";
import { CONTEXT_OVERFLOW_REGEX } from "./errorClassifier.js";
import { getRegistryEntry } from "../config/providerRegistry.js";
const MODEL_FAMILIES = {
  // Gemini 3 / 3.1 Pro family — ordered by preference
  "gemini-3-pro": [
    "gemini-3.1-pro-preview",
    "gemini-3-pro-preview",
    "gemini-3.1-pro-high",
    "gemini-3-pro-high",
    "gemini-3.1-pro-low",
    "gemini-3-pro-low"
  ],
  "gemini-3.1-pro": [
    "gemini-3.1-pro-preview",
    "gemini-3-pro-preview",
    "gemini-3.1-pro-high",
    "gemini-3-pro-high",
    "gemini-3.1-pro-low",
    "gemini-3-pro-low"
  ],
  "gemini-3-pro-preview": [
    "gemini-3.1-pro-preview",
    "gemini-3-pro-high",
    "gemini-3.1-pro-high",
    "gemini-3-pro-low",
    "gemini-3.1-pro-low"
  ],
  "gemini-3.1-pro-preview": [
    "gemini-3-pro-preview",
    "gemini-3.1-pro-high",
    "gemini-3-pro-high",
    "gemini-3.1-pro-low",
    "gemini-3-pro-low"
  ],
  "gemini-3-pro-high": [
    "gemini-3.1-pro-high",
    "gemini-3-pro-preview",
    "gemini-3.1-pro-preview",
    "gemini-3-pro-low",
    "gemini-3.1-pro-low"
  ],
  "gemini-3.1-pro-high": [
    "gemini-3-pro-high",
    "gemini-3.1-pro-preview",
    "gemini-3-pro-preview",
    "gemini-3.1-pro-low",
    "gemini-3-pro-low"
  ],
  // Gemini 2.5 Pro family
  "gemini-2.5-pro": ["gemini-2.5-pro-preview-06-05", "gemini-2.5-pro-exp-03-25"],
  "gemini-2.5-pro-preview-06-05": ["gemini-2.5-pro", "gemini-2.5-pro-exp-03-25"],
  // Claude Mythos family (Fable 5) — flagship falls to the next-best Opus
  // tiers before the cheaper Sonnet, matching the Opus family ordering.
  "claude-fable-5": ["claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5"],
  // Claude Opus family
  "claude-opus-4-8": ["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5"],
  "claude-opus-4-7": ["claude-opus-4-6", "claude-opus-4-5-20251101", "claude-sonnet-5"],
  "claude-opus-4-6": ["claude-opus-4-6-thinking", "claude-opus-4-5-20251101", "claude-sonnet-5"],
  "claude-opus-4-6-thinking": ["claude-opus-4-6", "claude-opus-4-5-20251101"],
  // Claude Sonnet family — Sonnet 5 is the newest tier; degrade to 4.6 → 4.5 → 4.
  "claude-sonnet-5": [
    "claude-sonnet-4-6",
    "claude-sonnet-4-5-20250929",
    "claude-sonnet-4-20250514"
  ],
  "claude-sonnet-4-6": ["claude-sonnet-4-5-20250929", "claude-sonnet-4-20250514"],
  "claude-sonnet-4-5-20250929": ["claude-sonnet-4-6", "claude-sonnet-4-20250514"],
  // GPT-5 family
  "gpt-5": ["gpt-5-mini", "gpt-4o"],
  "gpt-5.1": ["gpt-5.1-mini", "gpt-5", "gpt-4o"]
};
const MODEL_UNAVAILABLE_FRAGMENTS = [
  "model not found",
  "model_not_found",
  "model not available",
  "model is not available",
  "no such model",
  "unsupported model",
  "unknown model",
  "this model does not exist",
  "invalid model",
  "model not supported",
  "does not support",
  "not enabled for",
  "access to model",
  "improperly formed request"
  // Kiro 400 (model unavailable)
];
function isModelUnavailableError(status, errorMessage) {
  if (status === 404) return true;
  if (status !== 400 && status !== 403) return false;
  const msg = errorMessage.toLowerCase();
  return MODEL_UNAVAILABLE_FRAGMENTS.some((fragment) => msg.includes(fragment));
}
function isContextOverflowError(status, errorMessage) {
  if (status !== 400) return false;
  return CONTEXT_OVERFLOW_REGEX.test(errorMessage);
}
function getNextFamilyFallback(currentModel, triedModels) {
  const parsed = parseModel(currentModel);
  const bareModel = parsed.model || currentModel;
  const provider = parsed.provider || parsed.providerAlias || "";
  const prefix = provider ? `${provider}/` : "";
  const lookupKey = bareModel.replace(/\./g, "-");
  const family = MODEL_FAMILIES[lookupKey] ?? MODEL_FAMILIES[bareModel];
  if (!family) return null;
  const registryEntry = provider ? getRegistryEntry(provider) : null;
  const supportedIds = registryEntry ? new Set(registryEntry.models.map((m) => m.id)) : null;
  for (const candidate of family) {
    let resolvedCandidate = candidate;
    if (supportedIds && !supportedIds.has(candidate)) {
      const dotVariant = candidate.replace(/-(\d+)-(\d+)$/, "-$1.$2");
      const dotVariant2 = candidate.replace(/-(\d+)-(\d+)-/, "-$1.$2-");
      if (supportedIds.has(dotVariant)) resolvedCandidate = dotVariant;
      else if (supportedIds.has(dotVariant2)) resolvedCandidate = dotVariant2;
    }
    const fullCandidate = `${prefix}${resolvedCandidate}`;
    if (!triedModels.has(fullCandidate)) {
      return fullCandidate;
    }
  }
  return null;
}
function isInModelFamily(model) {
  const parsed = parseModel(model);
  const bareModel = parsed.model || model;
  return bareModel in MODEL_FAMILIES;
}
function getModelFamily(model) {
  const parsed = parseModel(model);
  const bareModel = parsed.model || model;
  const prefix = parsed.provider || parsed.providerAlias ? `${parsed.provider || parsed.providerAlias}/` : "";
  const family = MODEL_FAMILIES[bareModel];
  if (!family) return [model];
  return [model, ...family.map((c) => `${prefix}${c}`)];
}
function findLargerContextModel(currentModel, availableModels) {
  const currentParsed = parseModel(currentModel);
  const currentProvider = currentParsed.provider || currentParsed.providerAlias || "unknown";
  const currentModelId = currentParsed.model || currentModel;
  const currentLimit = getModelContextLimit(currentProvider, currentModelId) ?? 0;
  let bestModel = null;
  let bestLimit = currentLimit;
  for (const candidate of availableModels) {
    if (candidate === currentModel) continue;
    const parsed = parseModel(candidate);
    const provider = parsed.provider || parsed.providerAlias || "unknown";
    const modelId = parsed.model || candidate;
    const limit = getModelContextLimit(provider, modelId) ?? 0;
    if (limit > bestLimit) {
      bestLimit = limit;
      bestModel = candidate;
    }
  }
  return bestModel;
}
export {
  findLargerContextModel,
  getModelFamily,
  getNextFamilyFallback,
  isContextOverflowError,
  isInModelFamily,
  isModelUnavailableError
};
