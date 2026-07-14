/**
 * Audio Speech Handler (TTS)
 *
 * Handles POST /v1/audio/speech (OpenAI TTS API format).
 * Returns audio binary stream.
 *
 * Supported provider formats:
 * - OpenAI / Qwen3 (openai-compatible): standard JSON → audio stream proxy
 * - Hyperbolic: POST { text } → { audio: base64 }
 * - Deepgram: POST { text } with model via query param, Token auth
 * - ElevenLabs: POST { text, model_id } to /v1/text-to-speech/{voice_id}
 * - Nvidia NIM: POST { input: { text }, voice, model } → audio binary
 * - HuggingFace Inference: POST { inputs: text } to /models/{model_id}
 * - Coqui TTS: POST { text, speaker_id } → WAV audio (local, no auth)
 * - Tortoise TTS: POST { text, voice } → audio binary (local, no auth)
 *
 * Converted from OmniRoute TypeScript.
 */

import { errorResponse } from "../utils/error.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ── Registry stubs ──────────────────────────────────────────────────
function parseSpeechModel(model) {
  if (model.includes("/")) {
    const [provider, ...rest] = model.split("/");
    return { provider, model: rest.join("/") };
  }
  return { provider: "openai", model };
}

const SPEECH_PROVIDERS = {
  openai: { id: "openai", baseUrl: "https://api.openai.com/v1/audio/speech", authType: "bearer", authHeader: "bearer", format: "openai" },
  hyperbolic: { id: "hyperbolic", baseUrl: "https://api.hyperbolic.xyz/v1/audio/speech", authType: "bearer", authHeader: "bearer", format: "hyperbolic" },
  deepgram: { id: "deepgram", baseUrl: "https://api.deepgram.com/v1/speak", authType: "token", authHeader: "token", format: "deepgram" },
  elevenlabs: { id: "elevenlabs", baseUrl: "https://api.elevenlabs.io/v1/text-to-speech", authType: "bearer", authHeader: "xi-api-key", format: "elevenlabs" },
  nvidia: { id: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1/audio/speech", authType: "bearer", authHeader: "bearer", format: "nvidia-tts" },
  huggingface: { id: "huggingface", baseUrl: "https://api-inference.huggingface.co/models", authType: "bearer", authHeader: "bearer", format: "huggingface-tts" },
  inworld: { id: "inworld", baseUrl: "https://api.inworld.ai/tts/v1/synthesize", authType: "bearer", authHeader: "bearer", format: "inworld" },
  cartesia: { id: "cartesia", baseUrl: "https://api.cartesia.ai/tts/bytes", authType: "bearer", authHeader: "x-api-key", format: "cartesia" },
  playht: { id: "playht", baseUrl: "https://api.play.ht/api/v2/tts/stream", authType: "bearer", authHeader: "bearer", format: "playht" },
  minimax: { id: "minimax", baseUrl: "https://api.minimaxi.com/v1/t2a_v2", authType: "bearer", authHeader: "Authorization", format: "minimax-tts" },
  coqui: { id: "coqui", baseUrl: "http://localhost:5002/api/tts", authType: "none", format: "coqui" },
  tortoise: { id: "tortoise", baseUrl: "http://localhost:5003/api/tts", authType: "none", format: "tortoise" },
};

function getSpeechProvider(providerId) {
  return SPEECH_PROVIDERS[providerId] || null;
}

function buildAuthHeaders(providerConfig, token) {
  if (!token) return {};
  if (providerConfig.authHeader === "bearer") return { Authorization: `Bearer ${token}` };
  if (providerConfig.authHeader === "token") return { Authorization: `Token ${token}` };
  if (providerConfig.authHeader === "xi-api-key") return { "xi-api-key": token };
  if (providerConfig.authHeader === "x-api-key") return { "x-api-key": token };
  return { Authorization: `Bearer ${token}` };
}

function stripTrailingSlashes(str) {
  return str.replace(/\/+$/, "");
}

function signAwsRequest(/* { method, url, region, service, headers, body, credentials } */) {
  // Stub — wire up AWS SigV4 signing when AWS Polly support is needed
  throw new Error("AWS SigV4 signing not implemented — install @aws-sdk/signature-v4 or configure signAwsRequest");
}

// ── Helpers ──────────────────────────────────────────────────────────

function extractUpstreamErrorMessage(parsed) {
  const detail = parsed?.detail;
  const candidates = [
    parsed?.err_msg,
    parsed?.error?.message,
    typeof parsed?.error === "string" ? parsed.error : null,
    parsed?.message,
    typeof detail === "string" ? detail : detail?.message,
  ];

  const raw = candidates.find(Boolean);
  return raw ? String(raw) : null;
}

function upstreamErrorResponse(res, errText) {
  let errorMessage;
  try {
    const parsed = JSON.parse(errText);
    errorMessage =
      extractUpstreamErrorMessage(parsed) || errText || `Upstream error (${res.status})`;
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

function audioStreamResponse(res, defaultContentType = "audio/mpeg") {
  const contentType = res.headers.get("content-type") || defaultContentType;
  return new Response(res.body, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": contentType,
      "Transfer-Encoding": "chunked",
    },
  });
}

function normalizeKieElevenLabsVoice(voice) {
  const value = typeof voice === "string" ? voice.trim() : "";
  const aliases = {
    alloy: "Rachel",
    echo: "Adam",
    fable: "Brian",
    onyx: "Antoni",
    nova: "Bella",
    shimmer: "Dorothy",
  };
  return aliases[value.toLowerCase()] || value || "Rachel";
}

function isJsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function parseKieResultJson(recordData) {
  // Stub — extract parsed result JSON from Kie task data
  const record = isJsonObject(recordData) ? recordData : {};
  const data = isJsonObject(record.data) ? record.data : {};
  const raw = data.resultJson || data.result_json || null;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return isJsonObject(raw) ? raw : {};
}

function getKieCallbackUrl(body) {
  return body?.callBackUrl || body?.callbackUrl || "";
}

function getKieErrorStatus(err, fallback) {
  if (typeof err === "object" && err !== null && "status" in err) {
    return Number(err.status) || fallback;
  }
  return fallback;
}

function getKieErrorMessage(err, fallback) {
  return err instanceof Error ? err.message : fallback;
}

const kieExecutor = {
  createTask: async () => { throw new Error("Kie executor not wired"); },
  getTaskStatusUrl: (baseUrl) => `${baseUrl}/task/status`,
  pollTask: async () => { throw new Error("Kie executor not wired"); },
};

const vertexGenerateSpeech = async () => { throw new Error("Vertex TTS not wired"); };

// ── Provider-specific handlers ───────────────────────────────────────

function findAudioUrlDeep(value) {
  if (!value) return null;
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value) && !/\.(jpg|jpeg|png|webp|gif|svg)(\?|$)/i.test(value)) {
      return value;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = findAudioUrlDeep(item);
      if (url) return url;
    }
    return null;
  }
  if (isJsonObject(value)) {
    const preferredKeys = [
      "audio_url", "audioUrl", "stream_audio_url", "streamAudioUrl",
      "resultUrl", "url", "downloadUrl", "resultUrls",
    ];
    for (const key of preferredKeys) {
      const url = findAudioUrlDeep(value[key]);
      if (url) return url;
    }
    for (const item of Object.values(value)) {
      const url = findAudioUrlDeep(item);
      if (url) return url;
    }
  }
  return null;
}

function findKieAudioUrl(recordData) {
  const record = isJsonObject(recordData) ? recordData : {};
  const data = isJsonObject(record.data) ? record.data : {};
  const resultJson = parseKieResultJson(recordData);
  const response = data.response;
  const nestedData = data.data;
  const candidates = [
    response,
    data,
    resultJson,
    ...(Array.isArray(response) ? response : []),
    ...(Array.isArray(nestedData) ? nestedData : []),
    ...(Array.isArray(resultJson.data) ? resultJson.data : []),
    ...(Array.isArray(resultJson.result) ? resultJson.result : []),
  ];
  for (const item of candidates) {
    const url = findAudioUrlDeep(item);
    if (url) return url;
  }
  return null;
}

function isValidPathSegment(segment) {
  return !segment.includes("..") && !segment.includes("//");
}

function getStringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function getProviderSpecificData(credentials) {
  return credentials?.providerSpecificData &&
    typeof credentials.providerSpecificData === "object" &&
    !Array.isArray(credentials.providerSpecificData)
    ? credentials.providerSpecificData
    : {};
}

// ── Hyperbolic TTS ──────────────────────────────────────────────────
async function handleHyperbolicSpeech(providerConfig, body, token) {
  const res = await fetch(providerConfig.baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...buildAuthHeaders(providerConfig, token),
    },
    body: JSON.stringify({ text: body.input }),
  });
  if (!res.ok) return upstreamErrorResponse(res, await res.text());
  const data = await res.json();
  const audioBuffer = Uint8Array.from(atob(data.audio), (c) => c.charCodeAt(0));
  return new Response(audioBuffer, { status: 200, headers: { "Content-Type": "audio/mpeg" } });
}

// ── Deepgram TTS ─────────────────────────────────────────────────────
async function handleDeepgramSpeech(providerConfig, body, modelId, token) {
  const url = new URL(providerConfig.baseUrl);
  url.searchParams.set("model", modelId);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...buildAuthHeaders(providerConfig, token) },
    body: JSON.stringify({ text: body.input }),
  });
  if (!res.ok) return upstreamErrorResponse(res, await res.text());
  return audioStreamResponse(res);
}

// ── ElevenLabs TTS ───────────────────────────────────────────────────
async function handleElevenLabsSpeech(providerConfig, body, modelId, token) {
  const voiceId = body.voice || "21m00Tcm4TlvDq8ikWAM";
  if (!isValidPathSegment(voiceId)) return errorResponse(400, "Invalid voice ID");
  const url = `${providerConfig.baseUrl}/${voiceId}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...buildAuthHeaders(providerConfig, token) },
    body: JSON.stringify({ text: body.input, model_id: modelId }),
  });
  if (!res.ok) return upstreamErrorResponse(res, await res.text());
  return audioStreamResponse(res);
}

// ── Nvidia NIM TTS ───────────────────────────────────────────────────
async function handleNvidiaTtsSpeech(providerConfig, body, modelId, token) {
  const res = await fetch(providerConfig.baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...buildAuthHeaders(providerConfig, token) },
    body: JSON.stringify({ input: { text: body.input }, voice: body.voice || "default", model: modelId }),
  });
  if (!res.ok) return upstreamErrorResponse(res, await res.text());
  return audioStreamResponse(res, "audio/wav");
}

// ── HuggingFace TTS ─────────────────────────────────────────────────
async function handleHuggingFaceTtsSpeech(providerConfig, body, modelId, token) {
  if (!isValidPathSegment(modelId)) return errorResponse(400, "Invalid model ID");
  const url = `${providerConfig.baseUrl}/${modelId}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...buildAuthHeaders(providerConfig, token) },
    body: JSON.stringify({ inputs: body.input }),
  });
  if (!res.ok) return upstreamErrorResponse(res, await res.text());
  return audioStreamResponse(res, "audio/wav");
}

// ── Inworld TTS ──────────────────────────────────────────────────────
const INWORLD_AUDIO_FORMATS = {
  mp3: { audioEncoding: "MP3", mimeType: "audio/mpeg" },
  wav: { audioEncoding: "WAV", mimeType: "audio/wav" },
  opus: { audioEncoding: "OPUS", mimeType: "audio/opus" },
  pcm: { audioEncoding: "PCM", mimeType: "audio/pcm" },
};

async function handleInworldSpeech(providerConfig, body, modelId, token) {
  const requestedFormat = typeof body.response_format === "string" ? body.response_format.toLowerCase() : "mp3";
  const audioFormat = INWORLD_AUDIO_FORMATS[requestedFormat];
  if (!audioFormat) return errorResponse(400, "Inworld TTS supports response_format mp3, wav, opus, or pcm only");

  const res = await fetch(providerConfig.baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      text: body.input,
      voiceId: body.voice || undefined,
      modelId,
      audioConfig: { audioEncoding: audioFormat.audioEncoding },
    }),
  });
  if (!res.ok) return upstreamErrorResponse(res, await res.text());
  const data = await res.json();
  const audioBuffer = Uint8Array.from(atob(data.audioContent ?? ""), (c) => c.charCodeAt(0));
  const mimeType = typeof data.contentType === "string" && data.contentType ? data.contentType : audioFormat.mimeType;
  return new Response(audioBuffer, { status: 200, headers: { "Content-Type": mimeType } });
}

// ── Cartesia TTS ─────────────────────────────────────────────────────
async function handleCartesiaSpeech(providerConfig, body, modelId, token) {
  const outputFormat = body.response_format === "wav"
    ? { container: "wav", sample_rate: 44100 }
    : { container: "mp3", bit_rate: 128000, sample_rate: 44100 };
  const res = await fetch(providerConfig.baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": token,
      "Cartesia-Version": "2024-06-10",
    },
    body: JSON.stringify({
      model_id: modelId,
      transcript: body.input,
      ...(body.voice ? { voice: { mode: "id", id: body.voice } } : {}),
      output_format: outputFormat,
    }),
  });
  if (!res.ok) return upstreamErrorResponse(res, await res.text());
  return audioStreamResponse(res);
}

// ── PlayHT TTS ───────────────────────────────────────────────────────
async function handlePlayHtSpeech(providerConfig, body, modelId, token) {
  const [userId, apiKey] = (token || ":").split(":");
  const res = await fetch(providerConfig.baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
      "X-USER-ID": userId || "",
      Authorization: `Bearer ${apiKey || token}`,
    },
    body: JSON.stringify({
      text: body.input,
      voice: body.voice || "s3://voice-cloning-zero-shot/d9ff78ba-d016-47f6-b0ef-dd630f59414e/female-cs/manifest.json",
      voice_engine: modelId || "PlayDialog",
      output_format: body.response_format || "mp3",
      speed: body.speed || 1,
    }),
  });
  if (!res.ok) return upstreamErrorResponse(res, await res.text());
  return audioStreamResponse(res);
}

// ── Kie.ai TTS ───────────────────────────────────────────────────────
async function handleKieAudioSpeech(providerConfig, body, modelId, token) {
  const baseUrl = providerConfig.baseUrl.replace(/\/$/, "");
  const voice = normalizeKieElevenLabsVoice(body.voice);
  const payload = {
    model: modelId,
    callBackUrl: getKieCallbackUrl(body),
    input: {
      text: body.input,
      voice,
      stability: typeof body.stability === "number" ? body.stability : 0.5,
      similarity_boost: typeof body.similarity_boost === "number" ? body.similarity_boost : 0.75,
      style: typeof body.style === "number" ? body.style : 0,
      speed: typeof body.speed === "number" ? body.speed : 1,
      timestamps: body.timestamps === true,
      previous_text: body.previous_text || "",
      next_text: body.next_text || "",
      language_code: body.language_code || "",
    },
  };

  let data;
  try {
    data = await kieExecutor.createTask({ baseUrl, token, payload });
  } catch (err) {
    const status = getKieErrorStatus(err, 502);
    return Response.json(
      { error: { message: getKieErrorMessage(err, "Kie audio createTask failed"), code: status } },
      { status, headers: { ...CORS_HEADERS } }
    );
  }

  const taskId = data?.data?.taskId || data?.taskId;
  if (taskId) return pollKieAudioResult(baseUrl, modelId, taskId, token);

  const audioUrl = findKieAudioUrl(data);
  if (typeof audioUrl === "string" && audioUrl.length > 0) {
    const audioRes = await fetch(audioUrl);
    return audioStreamResponse(audioRes);
  }

  return errorResponse(502, data?.msg || data?.message || "Kie audio generation did not return taskId or audio URL");
}

async function pollKieAudioResult(baseUrl, modelId, taskId, token) {
  void modelId;
  const statusUrl = kieExecutor.getTaskStatusUrl(baseUrl);
  try {
    const { data, state } = await kieExecutor.pollTask({
      statusUrl,
      taskId: String(taskId),
      token,
      timeoutMs: 60000,
      pollIntervalMs: 2000,
    });
    if (state === "success") {
      const url = findKieAudioUrl(data);
      if (url) { const audioRes = await fetch(url); return audioStreamResponse(audioRes); }
      return errorResponse(502, "Kie audio task completed without audio URL");
    }
  } catch (err) {
    return errorResponse(getKieErrorStatus(err, 504), getKieErrorMessage(err, "Kie audio generation timed out or failed"));
  }
  return errorResponse(504, "Kie audio generation timed out or failed");
}

// ── AWS Polly TTS ────────────────────────────────────────────────────
function getAwsPollyProviderData(credentials) {
  return getProviderSpecificData(credentials);
}

function resolveAwsPollyRegion(providerSpecificData) {
  return getStringValue(providerSpecificData.region) ||
    getStringValue(providerSpecificData.awsRegion) ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    "us-east-1";
}

function resolveAwsPollyBaseUrl(providerSpecificData, region) {
  const configuredBaseUrl = getStringValue(providerSpecificData.baseUrl);
  const baseUrl = configuredBaseUrl || `https://polly.${region}.amazonaws.com`;
  return stripTrailingSlashes(baseUrl.replace(/\/v1\/speech\/?$/i, ""));
}

function normalizeAwsPollyEngine(modelId) {
  const engine = getStringValue(modelId) || "standard";
  return ["standard", "neural", "long-form", "generative"].includes(engine) ? engine : "standard";
}

function normalizeAwsPollyOutputFormat(responseFormat) {
  const format = getStringValue(responseFormat)?.toLowerCase();
  switch (format) {
    case "pcm": case "wav": return "pcm";
    case "opus": case "ogg_opus": return "ogg_opus";
    case "ogg": case "ogg_vorbis": return "ogg_vorbis";
    case "json": return "json";
    case "mp3": default: return "mp3";
  }
}

function normalizeAwsPollyTextType(body) {
  const explicitTextType = getStringValue(body.text_type || body.textType)?.toLowerCase();
  if (explicitTextType === "ssml") return "ssml";
  if (explicitTextType === "text") return "text";
  const input = getStringValue(body.input) || "";
  return input.trim().startsWith("<speak") ? "ssml" : "text";
}

function getAwsPollySampleRate(responseFormat, sampleRate) {
  const explicit = getStringValue(sampleRate || null);
  if (explicit) return explicit;
  const outputFormat = normalizeAwsPollyOutputFormat(responseFormat);
  if (outputFormat === "ogg_opus") return "48000";
  if (outputFormat === "pcm") return "16000";
  return undefined;
}

async function handleAwsPollySpeech(providerConfig, body, modelId, token, credentials) {
  const providerSpecificData = getAwsPollyProviderData(credentials);
  const accessKeyId = getStringValue(providerSpecificData.accessKeyId) || getStringValue(providerSpecificData.awsAccessKeyId);
  const secretAccessKey = getStringValue(token);

  if (!accessKeyId) return errorResponse(400, "AWS Polly requires providerSpecificData.accessKeyId");
  if (!secretAccessKey) return errorResponse(401, "No AWS Secret Access Key for AWS Polly");

  const region = resolveAwsPollyRegion(providerSpecificData);
  const baseUrl = resolveAwsPollyBaseUrl(providerSpecificData, region);
  const url = `${baseUrl}/v1/speech`;
  const outputFormat = normalizeAwsPollyOutputFormat(body.response_format);
  const sampleRate = getAwsPollySampleRate(body.response_format, body.sample_rate || body.sampleRate);

  const requestBody = {
    Engine: normalizeAwsPollyEngine(modelId),
    OutputFormat: outputFormat,
    Text: body.input,
    TextType: normalizeAwsPollyTextType(body),
    VoiceId: getStringValue(body.voice) || getStringValue(providerSpecificData.defaultVoice) || "Joanna",
    ...(getStringValue(body.language_code || body.languageCode) ? { LanguageCode: getStringValue(body.language_code || body.languageCode) } : {}),
    ...(sampleRate ? { SampleRate: sampleRate } : {}),
  };
  const serializedBody = JSON.stringify(requestBody);

  const signedHeaders = signAwsRequest({
    method: "POST", url, region, service: "polly",
    headers: { "content-type": "application/json" },
    body: serializedBody,
    credentials: {
      accessKeyId,
      secretAccessKey,
      sessionToken: getStringValue(providerSpecificData.sessionToken) || getStringValue(providerSpecificData.awsSessionToken),
    },
  });

  const res = await fetch(url, { method: "POST", headers: signedHeaders, body: serializedBody });
  if (!res.ok) return upstreamErrorResponse(res, await res.text());
  return audioStreamResponse(res, outputFormat === "pcm" ? "audio/pcm" : "audio/mpeg");
}

// ── Xiaomi MiMo TTS ─────────────────────────────────────────────────
function normalizeXiaomiMimoSpeechUrl(baseUrl) {
  const configured = getStringValue(baseUrl) || "https://api.xiaomimimo.com/v1";
  const normalized = stripTrailingSlashes(configured).replace(/\/chat\/completions$/i, "");
  return `${normalized}/chat/completions`;
}

function normalizeXiaomiMimoMimeType(format) {
  switch (getStringValue(format)?.toLowerCase()) {
    case undefined: case null: case "mp3": case "audio/mp3": case "audio/mpeg": return "audio/mpeg";
    case "wav": case "audio/wav": return "audio/wav";
    default: return null;
  }
}

function getXiaomiMimoAudioData(data) {
  const messageAudio = data?.choices?.[0]?.message?.audio;
  const directAudio = data?.audio || data?.output_audio;
  const firstDataItem = Array.isArray(data?.data) ? data.data[0] : null;
  return (
    getStringValue(messageAudio?.data) || getStringValue(messageAudio?.b64_json) ||
    getStringValue(directAudio?.data) || getStringValue(directAudio?.b64_json) ||
    getStringValue(firstDataItem?.b64_json) || getStringValue(firstDataItem?.audio) ||
    getStringValue(data?.audioContent) || getStringValue(data?.audio_content)
  );
}

async function handleXiaomiMimoSpeech(providerConfig, body, modelId, token, credentials) {
  const providerSpecificData = getProviderSpecificData(credentials);
  const url = normalizeXiaomiMimoSpeechUrl(providerSpecificData.baseUrl || providerConfig.baseUrl);
  const audioMimeType = normalizeXiaomiMimoMimeType(body.response_format);
  if (!audioMimeType) return errorResponse(400, "Xiaomi MiMo TTS supports response_format mp3 or wav only");

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...buildAuthHeaders(providerConfig, token) },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "assistant", content: body.input }],
      audio: { format: audioMimeType, voice: body.voice || getStringValue(providerSpecificData.defaultVoice) || "mimo_default" },
    }),
  });
  if (!res.ok) return upstreamErrorResponse(res, await res.text());

  const contentType = res.headers.get("content-type") || "";
  if (contentType.startsWith("audio/")) return audioStreamResponse(res, audioMimeType);

  const data = await res.json();
  const audioBase64 = getXiaomiMimoAudioData(data);
  if (!audioBase64) return errorResponse(502, "Xiaomi MiMo TTS response did not contain audio data");

  const audioBuffer = Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0));
  return new Response(audioBuffer, { status: 200, headers: { ...CORS_HEADERS, "Content-Type": audioMimeType } });
}

// ── MiniMax TTS ──────────────────────────────────────────────────────
function hexToBytes(audioHex) {
  const clean = typeof audioHex === "string" ? audioHex.trim() : "";
  if (!clean) throw new Error("MiniMax TTS returned no audio");
  if (clean.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(clean)) throw new Error("MiniMax TTS returned invalid audio");
  const len = clean.length / 2;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

async function handleMinimaxSpeech(providerConfig, body, modelId, token) {
  const voiceId = (typeof body.voice === "string" && body.voice) || "English_expressive_narrator";
  const res = await fetch(providerConfig.baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...buildAuthHeaders(providerConfig, token) },
    body: JSON.stringify({
      model: modelId || "speech-2.8-hd",
      text: body.input,
      stream: false,
      language_boost: "auto",
      output_format: "hex",
      voice_setting: {
        voice_id: voiceId,
        speed: typeof body.speed === "number" ? body.speed : 1,
        vol: 1,
        pitch: 0,
      },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
    }),
  });

  const rawText = await res.text();
  let data = {};
  if (rawText) {
    try {
      const parsed = JSON.parse(rawText);
      if (parsed && typeof parsed === "object") data = parsed;
    } catch { data = {}; }
  }

  if (!res.ok) return upstreamErrorResponse(res, rawText);

  const baseResp = (data.base_resp || data.baseResp) || {};
  const statusCode = Number(baseResp.status_code ?? baseResp.statusCode ?? 0);
  const statusMessage = String(baseResp.status_msg || baseResp.statusMsg || data.message || "");
  if (statusCode !== 0) return errorResponse(502, `MiniMax TTS: ${statusMessage || "upstream error"}`);

  const audioField = data.data?.audio;
  let bytes;
  try {
    bytes = hexToBytes(audioField);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "invalid audio";
    return errorResponse(502, `MiniMax TTS: ${msg}`);
  }

  return new Response(bytes, { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "audio/mpeg" } });
}

// ── Coqui / Tortoise TTS (local, no auth) ────────────────────────────
async function handleCoquiSpeech(providerConfig, body) {
  const res = await fetch(providerConfig.baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: body.input, speaker_id: body.voice || undefined }),
  });
  if (!res.ok) return upstreamErrorResponse(res, await res.text());
  const contentType = res.headers.get("content-type") || "audio/wav";
  return new Response(res.body, { status: 200, headers: { "Content-Type": contentType } });
}

async function handleTortoiseSpeech(providerConfig, body) {
  const res = await fetch(providerConfig.baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: body.input, voice: body.voice || "random" }),
  });
  if (!res.ok) return upstreamErrorResponse(res, await res.text());
  const contentType = res.headers.get("content-type") || "audio/wav";
  return new Response(res.body, { status: 200, headers: { "Content-Type": contentType } });
}

// ── Main Handler ─────────────────────────────────────────────────────

/**
 * Handle audio speech (TTS) request
 */
export async function handleAudioSpeech({
  body,
  credentials,
  resolvedProvider = null,
  resolvedModel = null,
}) {
  if (!body.model) return errorResponse(400, "model is required");
  if (!body.input) return errorResponse(400, "input is required");

  let providerConfig = resolvedProvider;
  let modelId = resolvedModel;
  if (!providerConfig) {
    const parsed = parseSpeechModel(body.model);
    providerConfig = parsed.provider ? getSpeechProvider(parsed.provider) : null;
    modelId = parsed.model;
  }

  if (!providerConfig) {
    return errorResponse(
      400,
      `No speech provider found for model "${body.model}". Use format provider/model. Available: openai, hyperbolic, deepgram, nvidia, elevenlabs, huggingface, inworld, cartesia, playht, kie, aws-polly, xiaomi-mimo, coqui, tortoise, qwen`
    );
  }

  const token =
    providerConfig.authType === "none" ? null : credentials?.apiKey || credentials?.accessToken;
  if (providerConfig.authType !== "none" && !token) {
    return errorResponse(401, `No credentials for speech provider: ${providerConfig.id}`);
  }

  try {
    if (providerConfig.format === "vertex-gemini-tts") {
      const { audio, contentType } = await vertexGenerateSpeech(credentials, {
        model: modelId, input: body.input, voice: body.voice,
      });
      return new Response(audio, { status: 200, headers: { ...CORS_HEADERS, "Content-Type": contentType } });
    }

    if (providerConfig.format === "hyperbolic") return handleHyperbolicSpeech(providerConfig, body, token);
    if (providerConfig.format === "deepgram") return handleDeepgramSpeech(providerConfig, body, modelId, token);
    if (providerConfig.format === "elevenlabs") return handleElevenLabsSpeech(providerConfig, body, modelId, token);
    if (providerConfig.format === "nvidia-tts") return handleNvidiaTtsSpeech(providerConfig, body, modelId, token);
    if (providerConfig.format === "huggingface-tts") return handleHuggingFaceTtsSpeech(providerConfig, body, modelId, token);
    if (providerConfig.format === "inworld") return handleInworldSpeech(providerConfig, body, modelId, token);
    if (providerConfig.format === "cartesia") return handleCartesiaSpeech(providerConfig, body, modelId, token);
    if (providerConfig.format === "playht") return handlePlayHtSpeech(providerConfig, body, modelId, token);
    if (providerConfig.format === "kie-audio") return handleKieAudioSpeech(providerConfig, body, modelId, token);
    if (providerConfig.format === "aws-polly") return handleAwsPollySpeech(providerConfig, body, modelId, token, credentials);
    if (providerConfig.format === "xiaomi-mimo-tts") return handleXiaomiMimoSpeech(providerConfig, body, modelId, token, credentials);
    if (providerConfig.format === "minimax-tts") return handleMinimaxSpeech(providerConfig, body, modelId, token);
    if (providerConfig.format === "coqui") return handleCoquiSpeech(providerConfig, body);
    if (providerConfig.format === "tortoise") return handleTortoiseSpeech(providerConfig, body);

    // Default: OpenAI-compatible JSON → audio stream proxy
    const res = await fetch(providerConfig.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...buildAuthHeaders(providerConfig, token) },
      body: JSON.stringify({
        model: modelId,
        input: body.input,
        voice: body.voice || "alloy",
        response_format: body.response_format || "mp3",
        speed: body.speed || 1.0,
      }),
    });
    if (!res.ok) return upstreamErrorResponse(res, await res.text());
    return audioStreamResponse(res);
  } catch (err) {
    return errorResponse(500, `Speech request failed: ${err.message}`);
  }
}
