/**
 * Audio Translation Handler
 *
 * Handles POST /v1/audio/translations (Whisper translate-to-English API
 * format). Proxies multipart/form-data to upstream providers that expose an
 * OpenAI-Whisper-compatible /audio/translations endpoint.
 *
 * Unlike /v1/audio/transcriptions, translation always outputs English text
 * regardless of the source audio language, so there is no `language` input
 * field — only `model`, `file`, `prompt`, `response_format`, and
 * `temperature` are forwarded upstream.
 *
 * Converted from OmniRoute TypeScript.
 */

import { errorResponse } from "../utils/error.js";

// ── Registry stubs ──────────────────────────────────────────────────
function parseTranslationModel(model) {
  if (model.includes("/")) {
    const [provider, ...rest] = model.split("/");
    return { provider, model: rest.join("/") };
  }
  return { provider: "openai", model };
}

const TRANSLATION_PROVIDERS = {
  openai: { id: "openai", baseUrl: "https://api.openai.com/v1/audio/translations", authType: "bearer", authHeader: "bearer" },
  groq: { id: "groq", baseUrl: "https://api.groq.com/openai/v1/audio/translations", authType: "bearer", authHeader: "bearer" },
};

function getTranslationProvider(providerId) {
  return TRANSLATION_PROVIDERS[providerId] || null;
}

function buildAuthHeaders(providerConfig, token) {
  if (!token) return {};
  if (providerConfig.authHeader === "bearer") return { Authorization: `Bearer ${token}` };
  if (providerConfig.authHeader === "token") return { Authorization: `Token ${token}` };
  return { Authorization: `Bearer ${token}` };
}

// ── Multipart builder (from audioTranscription) ──────────────────────

function getUploadedFileName(file) {
  return typeof file.name === "string" && file.name.length > 0 ? file.name : "audio.wav";
}

async function buildMultipartBody(file, fields) {
  const boundary = "----OmniRouteAudioBoundary" + Date.now().toString(36);
  const parts = [];
  const encoder = new TextEncoder();

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      )
    );
  }

  const fileName = getUploadedFileName(file)
    .replace(/["]/g, "_")
    .replace(/[\r\n]/g, "_");
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  parts.push(
    encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${file.type || "application/octet-stream"}\r\n\r\n`
    )
  );
  parts.push(fileBytes);
  parts.push(encoder.encode(`\r\n--${boundary}--\r\n`));

  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }

  return { body, contentType: "multipart/form-data; boundary=" + boundary };
}

// ── Error helper ─────────────────────────────────────────────────────

function extractUpstreamErrorMessage(errText, status) {
  try {
    const parsed = JSON.parse(errText);
    const raw =
      parsed?.error?.message ||
      (typeof parsed?.error === "string" ? parsed.error : null) ||
      parsed?.message ||
      null;
    return raw ? String(raw) : errText || `Upstream error (${status})`;
  } catch {
    return errText || `Upstream error (${status})`;
  }
}

/**
 * Handle audio translation request
 */
export async function handleAudioTranslation({
  formData,
  credentials,
  resolvedProvider = null,
  resolvedModel = null,
}) {
  const model = formData.get("model");
  if (typeof model !== "string" || !model) {
    return errorResponse(400, "model is required");
  }

  const fileEntry = formData.get("file");
  if (!(fileEntry instanceof Blob)) {
    return errorResponse(400, "file is required");
  }
  const file = fileEntry;

  // Use pre-resolved provider/model from route handler if available.
  let providerConfig = resolvedProvider;
  let modelId = resolvedModel;
  if (!providerConfig) {
    const parsed = parseTranslationModel(model);
    providerConfig = parsed.provider ? getTranslationProvider(parsed.provider) : null;
    modelId = parsed.model;
  }

  if (!providerConfig) {
    return errorResponse(
      400,
      `No translation provider found for model "${model}". Available: openai, groq`
    );
  }

  const token =
    providerConfig.authType === "none" ? null : credentials?.apiKey || credentials?.accessToken;
  if (providerConfig.authType !== "none" && !token) {
    return errorResponse(401, `No credentials for translation provider: ${providerConfig.id}`);
  }

  // OpenAI Whisper translate-to-English params — no `language`, output is
  // always English regardless of the source audio language.
  const extraFields = {};
  for (const key of ["prompt", "response_format", "temperature"]) {
    const val = formData.get(key);
    if (val !== null && val !== undefined) {
      extraFields[key] = String(val);
    }
  }

  const { body: multipartBody, contentType: multipartCT } = await buildMultipartBody(file, {
    model: modelId,
    ...extraFields,
  });

  try {
    const res = await fetch(providerConfig.baseUrl, {
      method: "POST",
      headers: { ...buildAuthHeaders(providerConfig, token), "Content-Type": multipartCT },
      body: multipartBody,
    });

    if (!res.ok) {
      const errText = await res.text();
      return errorResponse(res.status, extractUpstreamErrorMessage(errText, res.status));
    }

    const data = await res.text();
    const respContentType = res.headers.get("content-type") || "application/json";

    return new Response(data, {
      status: 200,
      headers: { "Content-Type": respContentType },
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return errorResponse(500, `Translation request failed: ${error.message}`);
  }
}
