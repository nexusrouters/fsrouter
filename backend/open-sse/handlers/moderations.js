/**
 * Moderation Handler
 *
 * Handles POST /v1/moderations (OpenAI Moderations API format).
 * Converted from OmniRoute TypeScript.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

import { MODERATION_PROVIDERS, parseModerationModel, getModerationProvider } from "../config/moderationRegistry.js";

// ── Inline stubs for @/ imports ──────────────────────────────────────
function attachOmniRouteMetaHeaders(headers, meta) {
  if (meta.provider) headers.set("X-Provider", meta.provider);
  if (meta.model) headers.set("X-Model", meta.model);
  if (meta.latencyMs != null) headers.set("X-Latency-Ms", String(meta.latencyMs));
}

function generateRequestId() {
  return crypto.randomUUID();
}

import { errorResponse } from "../utils/error.js";

/**
 * Handle moderation request
 */
export async function handleModeration({ body, credentials }) {
  const startTime = Date.now();
  if (!body.input) {
    return errorResponse(400, "input is required");
  }

  // Default to latest moderation model
  const model = body.model || "omni-moderation-latest";
  const { provider: providerId, model: modelId } = parseModerationModel(model);
  const providerConfig = providerId ? getModerationProvider(providerId) : null;

  if (!providerConfig) {
    return errorResponse(
      400,
      `No moderation provider found for model "${model}". Available: openai`
    );
  }

  const token = credentials?.apiKey || credentials?.accessToken;
  if (!token) {
    return errorResponse(401, `No credentials for moderation provider: ${providerId}`);
  }

  try {
    const res = await fetch(providerConfig.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: modelId,
        input: body.input,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return new Response(errText, {
        status: res.status,
        headers: {
          "Content-Type": "application/json",
          ...CORS_HEADERS,
        },
      });
    }

    const data = await res.json();
    const headers = new Headers({ ...CORS_HEADERS, "Content-Type": "application/json" });
    attachOmniRouteMetaHeaders(headers, {
      provider: providerId,
      model: modelId,
      costUsd: 0,
      latencyMs: Date.now() - startTime,
      requestId: generateRequestId(),
    });
    return new Response(JSON.stringify(data), { status: 200, headers });
  } catch (err) {
    return errorResponse(500, `Moderation request failed: ${err.message}`);
  }
}
