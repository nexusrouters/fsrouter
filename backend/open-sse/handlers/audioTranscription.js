/**
 * Audio Transcription Handler
 *
 * Handles POST /v1/audio/transcriptions (Whisper API format).
 * Proxies multipart/form-data to upstream providers.
 *
 * Supported provider formats:
 * - OpenAI/Groq/Qwen3: standard multipart form-data proxy
 * - Deepgram: raw binary audio POST with model via query param
 * - AssemblyAI: async workflow (upload → submit → poll)
 * - Nvidia NIM: multipart POST, transform response to { text }
 * - HuggingFace Inference: POST raw binary to /models/{model_id}
 *
 * Converted from OmniRoute TypeScript.
 */

import { Buffer } from "node:buffer";
import { errorResponse } from "../utils/error.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ── Registry stubs ──────────────────────────────────────────────────
function parseTranscriptionModel(model) {
  if (model.includes("/")) {
    const [provider, ...rest] = model.split("/");
    return { provider, model: rest.join("/") };
  }
  return { provider: "openai", model };
}

const TRANSCRIPTION_PROVIDERS = {
  openai: { id: "openai", baseUrl: "https://api.openai.com/v1/audio/transcriptions", authType: "bearer", authHeader: "bearer", format: "openai" },
  groq: { id: "groq", baseUrl: "https://api.groq.com/openai/v1/audio/transcriptions", authType: "bearer", authHeader: "bearer", format: "openai" },
  deepgram: { id: "deepgram", baseUrl: "https://api.deepgram.com/v1/listen", authType: "token", authHeader: "token", format: "deepgram" },
  assemblyai: { id: "assemblyai", baseUrl: "https://api.assemblyai.com/v2/transcript", authType: "bearer", authHeader: "bearer", format: "assemblyai" },
  nvidia: { id: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1/audio/transcriptions", authType: "bearer", authHeader: "bearer", format: "nvidia-asr" },
  huggingface: { id: "huggingface", baseUrl: "https://api-inference.huggingface.co/models", authType: "bearer", authHeader: "bearer", format: "huggingface-asr" },
};

function getTranscriptionProvider(providerId) {
  return TRANSCRIPTION_PROVIDERS[providerId] || null;
}

function buildAuthHeaders(providerConfig, token) {
  if (!token) return {};
  if (providerConfig.authHeader === "bearer") return { Authorization: `Bearer ${token}` };
  if (providerConfig.authHeader === "token") return { Authorization: `Token ${token}` };
  return { Authorization: `Bearer ${token}` };
}

// ── Helpers ──────────────────────────────────────────────────────────

function upstreamErrorResponse(res, errText) {
  // Always return JSON so the client can parse the error reliably
  let errorMessage;
  try {
    const parsed = JSON.parse(errText);
    const raw =
      parsed?.err_msg ||
      parsed?.error?.message ||
      (typeof parsed?.error === "string" ? parsed.error : null) ||
      parsed?.message ||
      (typeof parsed?.detail === "string" ? parsed.detail : parsed?.detail?.message) ||
      null;
    errorMessage = raw ? String(raw) : errText || `Upstream error (${res.status})`;
  } catch {
    errorMessage = errText || `Upstream error (${res.status})`;
  }

  return Response.json(
    { error: { message: errorMessage, code: res.status } },
    {
      status: res.status,
      headers: { ...CORS_HEADERS },
    }
  );
}

function isValidPathSegment(segment) {
  return !segment.includes("..") && !segment.includes("//");
}

function getUploadedFileName(file) {
  return typeof file.name === "string" && file.name.length > 0 ? file.name : "audio.wav";
}

export async function buildMultipartBody(file, fields) {
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

function resolveAudioContentType(file) {
  const browserType = (file.type || "").toLowerCase();
  const fileName = typeof file.name === "string" ? file.name.toLowerCase() : "";

  if (browserType.startsWith("audio/")) return browserType;

  const ext = fileName.includes(".") ? fileName.split(".").pop() : "";
  const EXT_TO_MIME = {
    mp3: "audio/mpeg",
    mp4: "audio/mp4",
    m4a: "audio/mp4",
    wav: "audio/wav",
    ogg: "audio/ogg",
    flac: "audio/flac",
    webm: "audio/webm",
    aac: "audio/aac",
    wma: "audio/x-ms-wma",
    opus: "audio/opus",
  };
  if (ext && EXT_TO_MIME[ext]) return EXT_TO_MIME[ext];

  return "application/octet-stream";
}

// ── Provider-specific handlers ───────────────────────────────────────

async function handleDeepgramTranscription(providerConfig, file, modelId, token, formData) {
  const url = new URL(providerConfig.baseUrl);
  url.searchParams.set("model", modelId);
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("punctuate", "true");

  const langParam = formData?.get("language");
  if (typeof langParam === "string" && langParam.trim()) {
    url.searchParams.set("language", langParam.trim());
  } else {
    url.searchParams.set("detect_language", "true");
  }

  const arrayBuffer = await file.arrayBuffer();

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      ...buildAuthHeaders(providerConfig, token),
      "Content-Type": resolveAudioContentType(file),
    },
    body: arrayBuffer,
  });

  if (!res.ok) {
    return upstreamErrorResponse(res, await res.text());
  }

  const data = await res.json();
  const text = data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? null;

  return Response.json(
    { text: text ?? "", noSpeechDetected: text === null || text === "" },
    { headers: { ...CORS_HEADERS } }
  );
}

async function handleAssemblyAITranscription(providerConfig, file, modelId, token) {
  const authHeaders = buildAuthHeaders(providerConfig, token);

  const arrayBuffer = await file.arrayBuffer();
  const uploadRes = await fetch("https://api.assemblyai.com/v2/upload", {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/octet-stream" },
    body: arrayBuffer,
  });

  if (!uploadRes.ok) {
    return upstreamErrorResponse(uploadRes, await uploadRes.text());
  }

  const { upload_url } = await uploadRes.json();

  const submitRes = await fetch(providerConfig.baseUrl, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      audio_url: upload_url,
      speech_models: [modelId],
      language_detection: true,
    }),
  });

  if (!submitRes.ok) {
    return upstreamErrorResponse(submitRes, await submitRes.text());
  }

  const { id: transcriptId } = await submitRes.json();

  const pollUrl = `${providerConfig.baseUrl}/${transcriptId}`;
  const maxWait = 120_000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    await new Promise((r) => setTimeout(r, 2000));

    const pollRes = await fetch(pollUrl, { headers: authHeaders });
    if (!pollRes.ok) continue;

    const result = await pollRes.json();

    if (result.status === "completed") {
      return Response.json({ text: result.text || "" }, { headers: { ...CORS_HEADERS } });
    }

    if (result.status === "error") {
      return errorResponse(500, result.error || "AssemblyAI transcription failed");
    }
  }

  return errorResponse(504, "AssemblyAI transcription timed out after 120s");
}

async function handleNvidiaTranscription(providerConfig, file, modelId, token) {
  const { body, contentType } = await buildMultipartBody(file, { model: modelId });

  const res = await fetch(providerConfig.baseUrl, {
    method: "POST",
    headers: { ...buildAuthHeaders(providerConfig, token), "Content-Type": contentType },
    body,
  });

  if (!res.ok) {
    return upstreamErrorResponse(res, await res.text());
  }

  const data = await res.json();
  const text = data.text || data.transcript || "";

  return Response.json({ text }, { headers: { ...CORS_HEADERS } });
}

async function handleHuggingFaceTranscription(providerConfig, file, modelId, token) {
  if (!isValidPathSegment(modelId)) {
    return errorResponse(400, "Invalid model ID");
  }
  const url = `${providerConfig.baseUrl}/${modelId}`;
  const arrayBuffer = await file.arrayBuffer();

  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...buildAuthHeaders(providerConfig, token),
      "Content-Type": resolveAudioContentType(file),
    },
    body: arrayBuffer,
  });

  if (!res.ok) {
    return upstreamErrorResponse(res, await res.text());
  }

  const data = await res.json();
  const text = data.text || "";

  return Response.json({ text }, { headers: { ...CORS_HEADERS } });
}

// ── Main handler ─────────────────────────────────────────────────────

/**
 * Handle audio transcription request
 */
export async function handleAudioTranscription({
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
    const parsed = parseTranscriptionModel(model);
    providerConfig = parsed.provider ? getTranscriptionProvider(parsed.provider) : null;
    modelId = parsed.model;
  }

  if (!providerConfig) {
    return errorResponse(
      400,
      `No transcription provider found for model "${model}". Available: openai, groq, deepgram, assemblyai, nvidia, huggingface, qwen`
    );
  }

  // Skip credential check for local providers (authType: "none")
  const token =
    providerConfig.authType === "none" ? null : credentials?.apiKey || credentials?.accessToken;
  if (providerConfig.authType !== "none" && !token) {
    return errorResponse(401, `No credentials for transcription provider: ${providerConfig.id}`);
  }

  // Route to provider-specific handler
  if (providerConfig.format === "deepgram") {
    return handleDeepgramTranscription(providerConfig, file, modelId, token, formData);
  }

  if (providerConfig.format === "assemblyai") {
    return handleAssemblyAITranscription(providerConfig, file, modelId, token);
  }

  if (providerConfig.format === "nvidia-asr") {
    return handleNvidiaTranscription(providerConfig, file, modelId, token);
  }

  if (providerConfig.format === "huggingface-asr") {
    return handleHuggingFaceTranscription(providerConfig, file, modelId, token);
  }

  // Default: OpenAI/Groq/Qwen3-compatible multipart proxy
  const extraFields = {};
  for (const key of [
    "language",
    "prompt",
    "response_format",
    "temperature",
    "timestamp_granularities[]",
  ]) {
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
      return upstreamErrorResponse(res, await res.text());
    }

    const data = await res.text();
    const respContentType = res.headers.get("content-type") || "application/json";

    return new Response(data, {
      status: 200,
      headers: { "Content-Type": respContentType },
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return errorResponse(500, `Transcription request failed: ${error.message}`);
  }
}
