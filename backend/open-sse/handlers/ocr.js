/**
 * OCR Handler
 *
 * Handles POST /v1/ocr (Mistral OCR API format).
 * Converted from OmniRoute TypeScript.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

import { OCR_PROVIDERS, parseOcrModel, getOcrProvider } from "../config/ocrRegistry.js";

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
 * Handle OCR request
 */
export async function handleOcr({ body, credentials }) {
  const startTime = Date.now();
  if (!body.document) {
    return errorResponse(400, "document is required");
  }

  // Default to latest OCR model
  const model = body.model || "mistral-ocr-latest";
  const { provider: providerId, model: modelId } = parseOcrModel(model);
  const providerConfig = providerId ? getOcrProvider(providerId) : null;

  if (!providerConfig) {
    return errorResponse(400, `No OCR provider found for model "${model}". Available: mistral`);
  }

  const token = credentials?.apiKey || credentials?.accessToken;
  if (!token) {
    return errorResponse(401, `No credentials for OCR provider: ${providerId}`);
  }

  try {
    const res = await fetch(providerConfig.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ...body,
        model: modelId,
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
    return errorResponse(500, `OCR request failed: ${err.message}`);
  }
}
