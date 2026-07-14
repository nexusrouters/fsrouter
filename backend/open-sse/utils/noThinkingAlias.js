import { getModelSpec } from "@/shared/constants/modelSpecs";
const NO_THINKING_PREFIX = "no-think/";
function isNoThinkingAlias(modelId) {
  return typeof modelId === "string" && modelId.startsWith(NO_THINKING_PREFIX);
}
function stripNoThinkingAlias(modelId) {
  return isNoThinkingAlias(modelId) ? modelId.slice(NO_THINKING_PREFIX.length) : modelId;
}
function toNoThinkingAlias(qualifiedModelId) {
  return `${NO_THINKING_PREFIX}${qualifiedModelId}`;
}
function applyNoThinkingAlias(body, opts = {}) {
  if (!body || typeof body !== "object") return { applied: false };
  const model = body.model;
  if (!isNoThinkingAlias(model)) return { applied: false };
  const realModel = stripNoThinkingAlias(model);
  if (!realModel) return { applied: false };
  body.model = realModel;
  if (opts.claudeFormat === true) {
    body.thinking = { type: "disabled" };
  }
  delete body.reasoning_effort;
  delete body.reasoning;
  return { applied: true, realModel };
}
function bareModelName(id) {
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}
function shouldExposeNoThinkingAlias(model) {
  if (!model || typeof model !== "object") return false;
  const id = model.id;
  if (typeof id !== "string" || id.length === 0) return false;
  if (model.owned_by === "combo") return false;
  if (isNoThinkingAlias(id)) return false;
  const name = bareModelName(id);
  const spec = getModelSpec(name);
  if (!spec) return false;
  if (spec.noThinkingAlias === true) return true;
  if (spec.noThinkingAlias === false) return false;
  return spec.supportsThinking === true && spec.rejectsThinkingDisabled !== true && /claude/i.test(name);
}
function normalizeProviderPrefix(qualifiedId, aliasToCanonical) {
  const slash = qualifiedId.indexOf("/");
  if (slash < 0) return qualifiedId;
  const prefix = qualifiedId.slice(0, slash);
  const canonical = aliasToCanonical[prefix];
  return canonical && canonical !== prefix ? `${canonical}${qualifiedId.slice(slash)}` : qualifiedId;
}
function appendNoThinkingVariants(models, aliasToCanonical) {
  if (!Array.isArray(models)) return models;
  const variants = [];
  for (const model of models) {
    if (!shouldExposeNoThinkingAlias(model)) continue;
    const rawId = model.id;
    const qualifiedId = aliasToCanonical ? normalizeProviderPrefix(rawId, aliasToCanonical) : rawId;
    const aliasId = toNoThinkingAlias(qualifiedId);
    const variant = { ...model, id: aliasId, root: aliasId };
    if (typeof model.name === "string" && model.name) {
      variant.name = `${model.name} (no thinking)`;
    }
    variants.push(variant);
  }
  return variants.length > 0 ? [...models, ...variants] : models;
}
export {
  NO_THINKING_PREFIX,
  appendNoThinkingVariants,
  applyNoThinkingAlias,
  isNoThinkingAlias,
  shouldExposeNoThinkingAlias,
  stripNoThinkingAlias,
  toNoThinkingAlias
};
