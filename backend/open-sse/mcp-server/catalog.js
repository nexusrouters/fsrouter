import { getCodexRequestDefaults } from "../../src/lib/providers/requestDefaults.ts";
import { getProviderConnections } from "../../src/lib/db/providers.ts";
import { AI_PROVIDERS, NOAUTH_PROVIDERS } from '../../dist/shared/constants/providers.ts.js';
function toRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function toString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}
function toStringArray(value, fallback = []) {
  return Array.isArray(value) ? value.map((item) => String(item)) : fallback;
}
function buildProviderAliasMap() {
  const aliasMap = {};
  for (const provider of Object.values(AI_PROVIDERS)) {
    if (!provider?.id) continue;
    aliasMap[provider.id] = provider.id;
    if (typeof provider.alias === "string" && provider.alias.length > 0) {
      aliasMap[provider.alias] = provider.id;
    }
  }
  for (const provider of Object.values(NOAUTH_PROVIDERS)) {
    if (!provider?.id) continue;
    aliasMap[provider.id] = provider.id;
    if ("alias" in provider && typeof provider.alias === "string" && provider.alias.length > 0) {
      aliasMap[provider.alias] = provider.id;
    }
  }
  return aliasMap;
}
function normalizeCapability(value) {
  switch (value) {
    case "embeddings":
      return "embedding";
    case "images":
      return "image";
    case "videos":
      return "video";
    case "moderations":
      return "moderation";
    case "chat-completions":
      return "chat";
    default:
      return value;
  }
}
function getCatalogModelCapabilities(model) {
  if (Array.isArray(model.capabilities) && model.capabilities.length > 0) {
    return toStringArray(model.capabilities, ["chat"]).map(normalizeCapability);
  }
  if (Array.isArray(model.supportedEndpoints) && model.supportedEndpoints.length > 0) {
    return toStringArray(model.supportedEndpoints, ["chat"]).map(normalizeCapability);
  }
  const type = toString(model.type);
  if (type) return [normalizeCapability(type)];
  return ["chat"];
}
function normalizeCatalogStatus(model, source, warning) {
  const explicitStatus = toString(model.status);
  if (explicitStatus === "available" || explicitStatus === "degraded" || explicitStatus === "unavailable") {
    return explicitStatus;
  }
  if (warning || source === "local_catalog") return "degraded";
  return "available";
}
function getConnectionThinkingEffort(connection) {
  const provider = typeof connection.provider === "string" ? connection.provider : null;
  const providerSpecificData = toRecord(connection.providerSpecificData);
  if (provider === "codex") {
    return getCodexRequestDefaults(providerSpecificData).reasoningEffort || "medium";
  }
  const rawThinkingEffort = toString(providerSpecificData.thinkingEffort);
  return rawThinkingEffort || void 0;
}
function normalizeProviderModelRecord(rawModel, fallbackProvider, source, warning, thinkingEffort) {
  const model = toRecord(rawModel);
  const id = toString(model.id, "");
  return {
    id,
    provider: toString(model.owned_by, toString(model.provider, fallbackProvider)),
    capabilities: getCatalogModelCapabilities(model),
    status: normalizeCatalogStatus(model, source, warning),
    ...thinkingEffort ? { thinkingEffort } : {},
    pricing: model.pricing
  };
}
function activeProviderConnections(connections, normalizeProviderId, requestedProvider) {
  return connections.filter((connection) => {
    const provider = typeof connection?.provider === "string" ? normalizeProviderId(connection.provider) : null;
    return !!provider && !!connection?.id && connection.isActive !== false && (!requestedProvider || provider === requestedProvider);
  });
}
function providerModelRequestSpecs(connections, normalizeProviderId) {
  return connections.map((connection) => ({
    provider: normalizeProviderId(String(connection.provider)),
    path: `/api/providers/${encodeURIComponent(String(connection.id))}/models?excludeHidden=true`,
    thinkingEffort: getConnectionThinkingEffort(connection)
  }));
}
function noAuthProviderSpec(requestedProvider) {
  return {
    provider: requestedProvider,
    path: `/api/v1/providers/${encodeURIComponent(requestedProvider)}/models`,
    thinkingEffort: void 0
  };
}
function emptyCatalogForProvider(requestedProvider) {
  return {
    models: [],
    source: "provider_connections",
    warning: `No active connections found for provider '${requestedProvider}'.`
  };
}
function rawModelsFromCatalog(raw) {
  if (Array.isArray(raw.models)) return raw.models;
  if (Array.isArray(raw.data)) return raw.data;
  return [];
}
function maybeCatalogModel(rawModel, spec, source, warning, requestedCapability) {
  const normalized = normalizeProviderModelRecord(rawModel, spec.provider, source, warning);
  if (spec.thinkingEffort && !normalized.thinkingEffort) normalized.thinkingEffort = spec.thinkingEffort;
  if (!normalized.id) return null;
  if (requestedCapability && !normalized.capabilities.includes(requestedCapability)) return null;
  return normalized;
}
function addCatalogModels(raw, spec, source, warning, requestedCapability, collectedModels) {
  for (const rawModel of rawModelsFromCatalog(raw)) {
    const normalized = maybeCatalogModel(rawModel, spec, source, warning, requestedCapability);
    if (normalized) collectedModels.set(`${normalized.provider}:${normalized.id}`, normalized);
  }
}
async function collectCatalogModels(requestSpecs, fetchJson, requestedCapability) {
  const collectedModels = /* @__PURE__ */ new Map();
  const warnings = /* @__PURE__ */ new Set();
  const sources = /* @__PURE__ */ new Set();
  for (const spec of requestSpecs) {
    const raw = toRecord(await fetchJson(spec.path));
    const source = toString(raw.source, spec.path.startsWith("/api/providers/") ? "api" : "v1_catalog");
    const warning = raw.warning ? String(raw.warning) : void 0;
    if (warning) warnings.add(warning);
    sources.add(source);
    addCatalogModels(raw, spec, source, warning, requestedCapability, collectedModels);
  }
  return { collectedModels, warnings, sources };
}
async function getMcpModelsCatalog(args, deps = {}) {
  const fetchJson = deps.fetchJson ?? ((path) => import("./server.ts").then((m) => m.omniRouteFetch(path)));
  const listProviderConnections = deps.listProviderConnections ?? getProviderConnections;
  const aliasMap = buildProviderAliasMap();
  const normalizeProviderId = (value) => aliasMap[value] || value;
  const requestedProvider = args.provider ? normalizeProviderId(args.provider) : null;
  const requestedCapability = args.capability ? normalizeCapability(args.capability) : null;
  let connections = await listProviderConnections();
  connections = Array.isArray(connections) ? connections : [];
  const activeConnections = activeProviderConnections(
    connections,
    normalizeProviderId,
    requestedProvider
  );
  const requestSpecs = providerModelRequestSpecs(activeConnections, normalizeProviderId);
  if (requestedProvider && requestSpecs.length === 0) {
    const isNoAuthProvider = Object.values(NOAUTH_PROVIDERS).some(
      (provider) => provider.id === requestedProvider
    );
    if (isNoAuthProvider) {
      requestSpecs.push(noAuthProviderSpec(requestedProvider));
    } else {
      return emptyCatalogForProvider(requestedProvider);
    }
  }
  const { collectedModels, warnings, sources } = await collectCatalogModels(
    requestSpecs,
    fetchJson,
    requestedCapability
  );
  return {
    models: [...collectedModels.values()],
    source: sources.size === 1 ? [...sources][0] : "aggregated_provider_models",
    ...warnings.size > 0 ? { warning: [...warnings].join(" | ") } : {}
  };
}
export {
  getMcpModelsCatalog
};
