import { Buffer } from "node:buffer";
import { sleep } from "../utils/sleep.ts";
import {
  parseSAFromApiKey,
  getAccessToken,
  looksLikeServiceAccountJson,
  isExpressApiKey
} from "./vertex.ts";
const DEFAULT_REGION = "us-central1";
function resolveRegion(credentials) {
  const psd = credentials?.providerSpecificData;
  if (psd && typeof psd === "object") {
    const region = psd.region;
    if (typeof region === "string" && region.trim().length > 0) return region.trim();
  }
  return DEFAULT_REGION;
}
async function resolveVertexAuth(credentials) {
  const apiKey = typeof credentials?.apiKey === "string" ? credentials.apiKey.trim() : "";
  const region = resolveRegion(credentials);
  let bearerToken = typeof credentials?.accessToken === "string" && credentials.accessToken.trim().length > 0 ? credentials.accessToken.trim() : null;
  let project = "";
  let expressKey = null;
  if (looksLikeServiceAccountJson(apiKey)) {
    const sa = parseSAFromApiKey(apiKey);
    project = typeof sa.project_id === "string" ? sa.project_id : "";
    if (!bearerToken) bearerToken = await getAccessToken(sa);
  } else if (isExpressApiKey(apiKey)) {
    expressKey = apiKey;
  }
  return { project, region, bearerToken, expressKey };
}
function buildModelRequest(auth, model, action) {
  const headers = { "Content-Type": "application/json" };
  if (auth.bearerToken && auth.project) {
    headers["Authorization"] = `Bearer ${auth.bearerToken}`;
    return {
      url: `https://${auth.region}-aiplatform.googleapis.com/v1/projects/${auth.project}/locations/${auth.region}/publishers/google/models/${model}:${action}`,
      headers
    };
  }
  if (auth.expressKey) {
    return {
      url: `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:${action}?key=${encodeURIComponent(
        auth.expressKey
      )}`,
      headers
    };
  }
  throw new Error(
    "Vertex AI requires a Service Account JSON (with project_id) or a Vertex AI Express API key"
  );
}
async function vertexError(res) {
  let detail = "";
  try {
    detail = await res.text();
  } catch {
  }
  let message = `Vertex AI error (${res.status})`;
  if (detail) {
    try {
      const parsed = JSON.parse(detail);
      message = parsed?.error?.message || message;
    } catch {
      message = detail.slice(0, 300);
    }
  }
  const err = new Error(message);
  err.status = res.status;
  return err;
}
function pcmToWav(pcm, sampleRate = 24e3, channels = 1, bitsPerSample = 16) {
  const blockAlign = channels * bitsPerSample / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
function parseSampleRate(mimeType) {
  if (!mimeType) return 24e3;
  const match = /rate=(\d+)/i.exec(mimeType);
  return match ? parseInt(match[1], 10) : 24e3;
}
function extractInlineAudio(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  for (const part of parts) {
    const inline = part?.inlineData;
    if (inline && typeof inline.data === "string" && inline.data.length > 0) {
      return {
        base64: inline.data,
        mimeType: typeof inline.mimeType === "string" ? inline.mimeType : "audio/L16;rate=24000"
      };
    }
  }
  return null;
}
function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((part) => part?.text).filter((text) => typeof text === "string").join("").trim();
}
async function vertexGenerateSpeech(credentials, options) {
  const auth = await resolveVertexAuth(credentials);
  const { url, headers } = buildModelRequest(auth, options.model, "generateContent");
  const payload = {
    contents: [{ role: "user", parts: [{ text: options.input }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: options.voice && options.voice.trim() ? options.voice.trim() : "Kore" }
        }
      }
    }
  };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
  if (!res.ok) throw await vertexError(res);
  const data = await res.json();
  const inline = extractInlineAudio(data);
  if (!inline) throw new Error("Vertex TTS returned no audio content");
  const pcm = Buffer.from(inline.base64, "base64");
  return { audio: pcmToWav(pcm, parseSampleRate(inline.mimeType)), contentType: "audio/wav" };
}
async function vertexTranscribe(credentials, options) {
  const auth = await resolveVertexAuth(credentials);
  const { url, headers } = buildModelRequest(auth, options.model, "generateContent");
  const instruction = options.prompt && options.prompt.trim().length > 0 ? options.prompt.trim() : `Transcribe this audio verbatim. Output only the spoken words${options.language ? ` (language: ${options.language})` : ""}, with no commentary.`;
  const payload = {
    contents: [
      {
        role: "user",
        parts: [
          { text: instruction },
          { inlineData: { mimeType: options.mimeType || "audio/wav", data: options.audioBase64 } }
        ]
      }
    ]
  };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
  if (!res.ok) throw await vertexError(res);
  return extractText(await res.json());
}
async function vertexGenerateMusic(credentials, options) {
  const auth = await resolveVertexAuth(credentials);
  const model = options.model && options.model.trim() ? options.model.trim() : "lyria-002";
  const { url, headers } = buildModelRequest(auth, model, "predict");
  const instance = { prompt: options.prompt };
  if (options.negativePrompt) instance.negative_prompt = options.negativePrompt;
  if (typeof options.seed === "number") instance.seed = options.seed;
  const parameters = {};
  if (typeof options.sampleCount === "number") parameters.sample_count = options.sampleCount;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ instances: [instance], parameters })
  });
  if (!res.ok) throw await vertexError(res);
  const data = await res.json();
  const base64 = data?.predictions?.[0]?.bytesBase64Encoded;
  if (typeof base64 !== "string" || base64.length === 0) {
    throw new Error("Vertex Lyria returned no audio");
  }
  return { base64, format: "wav" };
}
async function vertexGenerateVideo(credentials, options) {
  const auth = await resolveVertexAuth(credentials);
  const submit = buildModelRequest(auth, options.model, "predictLongRunning");
  const instance = { prompt: options.prompt };
  if (options.image) instance.image = options.image;
  const parameters = {
    sampleCount: typeof options.sampleCount === "number" ? options.sampleCount : 1
  };
  if (options.aspectRatio) parameters.aspectRatio = options.aspectRatio;
  if (typeof options.durationSeconds === "number") parameters.durationSeconds = options.durationSeconds;
  if (options.negativePrompt) parameters.negativePrompt = options.negativePrompt;
  const submitRes = await fetch(submit.url, {
    method: "POST",
    headers: submit.headers,
    body: JSON.stringify({ instances: [instance], parameters })
  });
  if (!submitRes.ok) throw await vertexError(submitRes);
  const op = await submitRes.json();
  const operationName = op?.name;
  if (typeof operationName !== "string" || operationName.length === 0) {
    throw new Error("Vertex Veo did not return an operation name");
  }
  const poll = buildModelRequest(auth, options.model, "fetchPredictOperation");
  const intervalMs = options.pollIntervalMs && options.pollIntervalMs > 0 ? options.pollIntervalMs : 1e4;
  const maxWaitMs = options.maxWaitMs && options.maxWaitMs > 0 ? options.maxWaitMs : 5 * 60 * 1e3;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const pollRes = await fetch(poll.url, {
      method: "POST",
      headers: poll.headers,
      body: JSON.stringify({ operationName })
    });
    if (!pollRes.ok) throw await vertexError(pollRes);
    const pollData = await pollRes.json();
    if (pollData?.done) {
      const opError = pollData?.error;
      if (opError) throw new Error(String(opError.message || "Veo operation failed"));
      const videos = pollData?.response?.videos;
      const video = Array.isArray(videos) ? videos[0] : null;
      if (video && typeof video.bytesBase64Encoded === "string") {
        return { base64: video.bytesBase64Encoded, format: "mp4" };
      }
      if (video && typeof video.gcsUri === "string") {
        return { url: video.gcsUri, format: "mp4" };
      }
      throw new Error("Veo operation completed but returned no video");
    }
  }
  throw new Error("Vertex Veo video generation timed out");
}
export {
  pcmToWav,
  vertexGenerateMusic,
  vertexGenerateSpeech,
  vertexGenerateVideo,
  vertexTranscribe
};
