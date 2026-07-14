/**
 * Embedding Provider Registry
 *
 * Defines providers that support the /v1/embeddings endpoint.
 */

export const EMBEDDING_PROVIDERS = {
  cohere: {
    id: "cohere", baseUrl: "https://api.cohere.com/v2/embed",
    authType: "apikey", authHeader: "bearer",
    models: [
      { id: "embed-v4.0", name: "Embed v4.0" },
      { id: "embed-multilingual-v3.0", name: "Embed Multilingual v3.0" },
      { id: "embed-multilingual-v3.0-images", name: "Embed Multilingual v3.0 Image" },
      { id: "embed-multilingual-light-v3.0", name: "Embed Multilingual Light v3.0" },
      { id: "embed-multilingual-light-v3.0-images", name: "Embed Multilingual Light v3.0 Image" },
    ],
  },
  nebius: {
    id: "nebius", baseUrl: "https://api.tokenfactory.nebius.com/v1/embeddings",
    authType: "apikey", authHeader: "bearer",
    models: [{ id: "Qwen/Qwen3-Embedding-8B", name: "Qwen3 Embedding 8B", dimensions: 4096 }],
  },
  openai: {
    id: "openai", baseUrl: "https://api.openai.com/v1/embeddings",
    authType: "apikey", authHeader: "bearer",
    models: [
      { id: "text-embedding-3-small", name: "Text Embedding 3 Small", dimensions: 1536 },
      { id: "text-embedding-3-large", name: "Text Embedding 3 Large", dimensions: 3072 },
      { id: "text-embedding-ada-002", name: "Text Embedding Ada 002", dimensions: 1536 },
    ],
  },
  "vercel-ai-gateway": {
    id: "vercel-ai-gateway", baseUrl: "https://ai-gateway.vercel.sh/v1/embeddings",
    authType: "apikey", authHeader: "bearer",
    models: [
      { id: "text-embedding-3-small", name: "Text Embedding 3 Small", dimensions: 1536 },
      { id: "text-embedding-3-large", name: "Text Embedding 3 Large", dimensions: 3072 },
    ],
  },
  upstage: {
    id: "upstage", baseUrl: "https://api.upstage.ai/v1/embeddings",
    authType: "apikey", authHeader: "bearer",
    models: [
      { id: "embedding-query", name: "Embedding Query", dimensions: 4096 },
      { id: "embedding-passage", name: "Embedding Passage", dimensions: 4096 },
    ],
  },
  mistral: {
    id: "mistral", baseUrl: "https://api.mistral.ai/v1/embeddings",
    authType: "apikey", authHeader: "bearer",
    models: [{ id: "mistral-embed", name: "Mistral Embed", dimensions: 1024 }],
  },
  together: {
    id: "together", baseUrl: "https://api.together.xyz/v1/embeddings",
    authType: "apikey", authHeader: "bearer",
    models: [
      { id: "BAAI/bge-large-en-v1.5", name: "BGE Large EN v1.5", dimensions: 1024 },
      { id: "togethercomputer/m2-bert-80M-8k-retrieval", name: "M2 BERT 80M 8K", dimensions: 768 },
    ],
  },
  fireworks: {
    id: "fireworks", baseUrl: "https://api.fireworks.ai/inference/v1/embeddings",
    authType: "apikey", authHeader: "bearer",
    models: [
      { id: "nomic-ai/nomic-embed-text-v1.5", name: "Nomic Embed Text v1.5", dimensions: 768 },
      { id: "accounts/fireworks/models/qwen3-embedding-8b", name: "Qwen3 Embedding 8B", dimensions: 4096 },
    ],
  },
  nvidia: {
    id: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1/embeddings",
    authType: "apikey", authHeader: "bearer",
    models: [{
      id: "nvidia/nv-embedqa-e5-v5", name: "NV EmbedQA E5 v5", dimensions: 1024,
      defaultParams: { input_type: "query" },
    }],
  },
  deepinfra: {
    id: "deepinfra", baseUrl: "https://api.deepinfra.com/v1/openai/embeddings",
    authType: "apikey", authHeader: "bearer",
    models: [
      { id: "Qwen/Qwen3-Embedding-8B", name: "Qwen3 Embedding 8B", dimensions: 4096 },
      { id: "Qwen/Qwen3-Embedding-4B", name: "Qwen3 Embedding 4B", dimensions: 2560 },
      { id: "Qwen/Qwen3-Embedding-0.6B", name: "Qwen3 Embedding 0.6B", dimensions: 1024 },
      { id: "BAAI/bge-large-en-v1.5", name: "BGE Large EN v1.5", dimensions: 1024 },
      { id: "BAAI/bge-base-en-v1.5", name: "BGE Base EN v1.5", dimensions: 768 },
      { id: "BAAI/bge-m3", name: "BGE-M3", dimensions: 1024 },
      { id: "intfloat/e5-large-v2", name: "E5 Large v2", dimensions: 1024 },
      { id: "thenlper/gte-large", name: "GTE Large", dimensions: 1024 },
    ],
  },
  openrouter: {
    id: "openrouter", baseUrl: "https://openrouter.ai/api/v1/embeddings",
    authType: "apikey", authHeader: "bearer",
    models: [
      { id: "openai/text-embedding-3-small", name: "Text Embedding 3 Small (OpenRouter)", dimensions: 1536 },
      { id: "openai/text-embedding-3-large", name: "Text Embedding 3 Large (OpenRouter)", dimensions: 3072 },
      { id: "openai/text-embedding-ada-002", name: "Text Embedding Ada 002 (OpenRouter)", dimensions: 1536 },
    ],
  },
  gemini: {
    id: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/embeddings",
    authType: "apikey", authHeader: "bearer",
    models: [
      { id: "gemini-embedding-2", name: "Gemini Embedding 2", dimensions: 768 },
      { id: "gemini-embedding-001", name: "Gemini Embedding 001", dimensions: 768 },
    ],
  },
  "voyage-ai": {
    id: "voyage-ai", baseUrl: "https://api.voyageai.com/v1/embeddings",
    authType: "apikey", authHeader: "bearer",
    models: [
      { id: "voyage-4-large", name: "Voyage 4 Large", dimensions: 1024 },
      { id: "voyage-4", name: "Voyage 4", dimensions: 1024 },
      { id: "voyage-4-lite", name: "Voyage 4 Lite", dimensions: 1024 },
      { id: "voyage-3-large", name: "Voyage 3 Large", dimensions: 1024 },
      { id: "voyage-multilingual-3.5", name: "Voyage Multilingual 3.5", dimensions: 1024 },
      { id: "voyage-code-3", name: "Voyage Code 3", dimensions: 1024 },
      { id: "voyage-code-2", name: "Voyage Code 2", dimensions: 1536 },
      { id: "voyage-finance-2", name: "Voyage Finance 2", dimensions: 1024 },
      { id: "voyage-law-2", name: "Voyage Law 2", dimensions: 1024 },
    ],
  },
  github: {
    id: "github", baseUrl: "https://models.inference.ai.azure.com/embeddings",
    authType: "apikey", authHeader: "bearer",
    models: [
      { id: "text-embedding-3-small", name: "Text Embedding 3 Small (GitHub)", dimensions: 1536 },
      { id: "text-embedding-3-large", name: "Text Embedding 3 Large (GitHub)", dimensions: 3072 },
    ],
  },
  "jina-ai": {
    id: "jina-ai", baseUrl: "https://api.jina.ai/v1/embeddings",
    authType: "apikey", authHeader: "bearer",
    models: [
      { id: "jina-embeddings-v5-text-small", name: "Jina Embeddings v5 Text Small", dimensions: 1024 },
      { id: "jina-embeddings-v5-text-nano", name: "Jina Embeddings v5 Text Nano", dimensions: 768 },
      { id: "jina-code-embeddings-1.5b", name: "Jina Code Embeddings 1.5B", dimensions: 1536 },
      { id: "jina-code-embeddings-0.5b", name: "Jina Code Embeddings 0.5B", dimensions: 896 },
      { id: "jina-embeddings-v4", name: "Jina Embeddings v4", dimensions: 2048 },
      { id: "jina-clip-v2", name: "Jina CLIP v2", dimensions: 1024 },
      { id: "jina-colbert-v2", name: "Jina ColBERT v2", dimensions: 128 },
    ],
  },
};

const EMBEDDING_PROVIDER_ALIASES = { jina: "jina-ai", voyage: "voyage-ai" };

function resolveEmbeddingProviderId(providerId) {
  return EMBEDDING_PROVIDER_ALIASES[providerId] || providerId;
}

function normalizeProviderScopedModelId(providerId, modelId) {
  const resolvedProvider = resolveEmbeddingProviderId(providerId);
  const provider = EMBEDDING_PROVIDERS[resolvedProvider];
  if (provider?.models.some((model) => model.id === modelId)) return modelId;
  const providerScopedModelId = `${resolvedProvider}/${modelId}`;
  if (provider?.models.some((model) => model.id === providerScopedModelId)) {
    return providerScopedModelId;
  }
  return modelId.startsWith(`${providerId}/`) ? modelId.slice(providerId.length + 1) : modelId;
}

function toProviderScopedModelId(providerId, modelId) {
  return modelId.startsWith(`${providerId}/`) ? modelId : `${providerId}/${modelId}`;
}

export function getEmbeddingProvider(providerId) {
  return EMBEDDING_PROVIDERS[resolveEmbeddingProviderId(providerId)] || null;
}

export function parseEmbeddingModel(modelStr, dynamicProviders) {
  if (!modelStr) return { provider: null, model: null };
  const slashIdx = modelStr.indexOf("/");
  if (slashIdx > 0) {
    const rawProvider = modelStr.slice(0, slashIdx);
    const resolvedProvider = resolveEmbeddingProviderId(rawProvider);
    if (EMBEDDING_PROVIDERS[resolvedProvider]) {
      return {
        provider: resolvedProvider,
        model: normalizeProviderScopedModelId(resolvedProvider, modelStr.slice(slashIdx + 1)),
      };
    }
    for (const [providerId] of Object.entries(EMBEDDING_PROVIDERS)) {
      if (modelStr.startsWith(providerId + "/")) {
        return {
          provider: providerId,
          model: normalizeProviderScopedModelId(providerId, modelStr.slice(providerId.length + 1)),
        };
      }
    }
    if (dynamicProviders) {
      for (const dp of dynamicProviders) {
        if (modelStr.startsWith(dp.id + "/")) {
          return { provider: dp.id, model: modelStr.slice(dp.id.length + 1) };
        }
      }
    }
    const provider = modelStr.slice(0, slashIdx);
    const model = modelStr.slice(slashIdx + 1);
    return { provider, model };
  }
  for (const [providerId, config] of Object.entries(EMBEDDING_PROVIDERS)) {
    if (config.models.some((m) => m.id === modelStr)) {
      return { provider: providerId, model: modelStr };
    }
  }
  return { provider: null, model: modelStr };
}

export function getEmbeddingDimension(modelStr) {
  const { provider, model } = parseEmbeddingModel(modelStr);
  if (!provider || !model) return undefined;
  const config = getEmbeddingProvider(provider);
  if (!config) return undefined;
  return config.models.find((m) => m.id === model)?.dimensions;
}

export function detectEmbeddingDimensionConflict(modelStrs) {
  const dimensions = {};
  for (const modelStr of modelStrs) {
    const dim = getEmbeddingDimension(modelStr);
    if (typeof dim === "number") dimensions[modelStr] = dim;
  }
  const distinct = [...new Set(Object.values(dimensions))].sort((a, b) => a - b);
  return { conflict: distinct.length > 1, dimensions, distinct };
}

export function getEmbeddingModelDefaultParams(providerConfig, modelId) {
  if (!providerConfig || !modelId) return undefined;
  return providerConfig.models.find((m) => m.id === modelId)?.defaultParams;
}

export function getAllEmbeddingModels() {
  const models = [];
  for (const [providerId, config] of Object.entries(EMBEDDING_PROVIDERS)) {
    for (const model of config.models) {
      models.push({
        id: toProviderScopedModelId(providerId, model.id),
        name: model.name,
        provider: providerId,
        dimensions: model.dimensions,
      });
    }
  }
  return models;
}

export function buildDynamicEmbeddingProvider(node) {
  if (!node.prefix || !node.baseUrl) {
    throw new Error(`Invalid provider_node: missing prefix or baseUrl`);
  }
  if (node.prefix.includes("/") || node.prefix.includes(" ")) {
    throw new Error(`Invalid provider_node prefix "${node.prefix}": must not contain / or spaces`);
  }
  const baseUrl = node.baseUrl.replace(/\/+$/, "");
  return {
    id: node.prefix,
    baseUrl: `${baseUrl}/embeddings`,
    authType: "none",
    authHeader: "none",
    models: [],
  };
}
