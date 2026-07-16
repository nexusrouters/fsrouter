// Import directly from file to avoid pulling in server-side dependencies via index.js
export {
  PROVIDER_MODELS,
  getProviderModels,
  getDefaultModel,
  isValidModel as isValidModelCore,
  findModelName,
  getModelTargetFormat,
  getModelStrip,
  PROVIDER_ID_TO_ALIAS,
  getModelsByProviderId,
  getModelUpstreamId,
  getModelQuotaFamily
} from "@/shared/config/providerModels.js";

import { AI_PROVIDERS, isOpenAICompatibleProvider } from "./providers.js";
import { PROVIDER_MODELS as MODELS } from "@/shared/config/providerModels.js";

// Providers that accept any model (passthrough)
const PASSTHROUGH_PROVIDERS = new Set(
  Object.entries(AI_PROVIDERS)
    .filter(([, p]) => p.passthroughModels)
    .map(([key]) => key)
);

// Wrap isValidModel with passthrough providers
export function isValidModel(aliasOrId, modelId) {
  if (isOpenAICompatibleProvider(aliasOrId)) return true;
  if (PASSTHROUGH_PROVIDERS.has(aliasOrId)) return true;
  const models = MODELS[aliasOrId];
  if (!models) return false;
  return models.some(m => m.id === modelId);
}

// Legacy AI_MODELS for backward compatibility
export const AI_MODELS = Object.entries(MODELS).flatMap(([alias, models]) =>
  models.map(m => ({ provider: alias, model: m.id, name: m.name }))
);

export function getProviderIdFromModel(modelName) {
  if (!modelName) return null;
  if (modelName.includes("/")) return modelName.split("/")[0];
  
  for (const [providerId, modelsArr] of Object.entries(MODELS)) {
    if (Array.isArray(modelsArr) && modelsArr.some(m => m.id === modelName)) {
      // Maps back aliases to their main provider IDs if needed, but returning alias/id is fine for icons
      // as our icon component handles aliased ids (like 'cc' -> 'codex')
      return providerId; 
    }
  }
  
  const lower = modelName.toLowerCase();
  if (lower.includes("gpt") || lower.includes("o1") || lower.includes("o3")) return "openai";
  if (lower.includes("claude")) return "anthropic";
  if (lower.includes("gemini")) return "gemini";
  if (lower.includes("deepseek")) return "deepseek";
  if (lower.includes("grok")) return "xai";
  if (lower.includes("qwen")) return "qwen";
  if (lower.includes("llama")) return "meta";
  if (lower.includes("command")) return "cohere";
  
  return null;
}

export function supportsVision(modelName) {
  if (!modelName) return false;
  const m = modelName.toLowerCase();
  return (
    m.includes("gpt-4o") ||
    m.includes("claude-3") || m.includes("claude-4") ||
    m.includes("claude-sonnet") ||
    m.includes("gemini") ||
    m.includes("vision") ||
    m.includes("vl") ||
    m.includes("pixtral") ||
    m.includes("llama-3.2") ||
    m.includes("mimo auto")
  );
}

export function supportsThinking(modelName) {
  if (!modelName) return false;
  const m = modelName.toLowerCase();
  // Match o1, o3, claude thinking, deepseek r1, or explicit thinking suffixes
  return (
    m.includes("thinking") ||
    m.includes("o1") ||
    m.includes("o3") ||
    m.includes("o4") ||
    m.includes("deepseek-r1") ||
    m.includes("reasoning") ||
    m.includes("flash") || // Gemini Flash has thinking capabilities in some versions
    m.includes("(low)") ||
    m.includes("(medium)") ||
    m.includes("(high)")
  );
}
