import { createHash } from "node:crypto";
import { BaseExecutor } from "./base.ts";
import { prepareToolMessages, buildToolAwareResult } from "../translator/webTools.ts";
import { sanitizeErrorMessage } from "../utils/error.ts";
const INNER_AI_CHAT_URL = "https://chatapi.innerai.com/chat";
const INNER_AI_PROFILE_URL = "https://platformapi.innerai.com/api/v1/users/profile";
const INNER_AI_MODELS_URL = "https://platformapi.innerai.com/api/v1/ai_models";
const INNER_AI_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const MODELS_CACHE_TTL_MS = 60 * 60 * 1e3;
const CACHE_MAX_ENTRIES = 1e3;
const credentialCache = /* @__PURE__ */ new Map();
const modelsCache = /* @__PURE__ */ new Map();
function lruTouch(map, key) {
  const value = map.get(key);
  if (value === void 0) return void 0;
  map.delete(key);
  map.set(key, value);
  return value;
}
function lruSet(map, key, value) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > CACHE_MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === void 0) break;
    map.delete(oldest);
  }
}
function tokenCacheKey(token) {
  return createHash("sha256").update(token).digest("hex");
}
function decodeJwtPayload(token) {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}
function parseCredential(rawApiKey) {
  const trimmed = rawApiKey.trim();
  const eqIdx = trimmed.indexOf("=");
  const stripped = eqIdx > 0 && !trimmed.startsWith("eyJ") ? trimmed.slice(eqIdx + 1).trim() : trimmed;
  const lastSpace = stripped.lastIndexOf(" ");
  if (lastSpace > 0) {
    const possibleEmail = stripped.slice(lastSpace + 1).trim();
    if (possibleEmail.includes("@")) {
      return { token: stripped.slice(0, lastSpace).trim(), credEmail: possibleEmail };
    }
  }
  return { token: stripped, credEmail: "" };
}
function makeErrorResult(status, message, body) {
  return {
    response: new Response(
      JSON.stringify({
        error: {
          message: sanitizeErrorMessage(message),
          type: "upstream_error",
          code: `HTTP_${status}`
        }
      }),
      { status, headers: { "Content-Type": "application/json" } }
    ),
    url: INNER_AI_CHAT_URL,
    headers: {},
    transformedBody: body
  };
}
function buildHeaders(token, email, deviceId) {
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": INNER_AI_USER_AGENT,
    // Cookie-based auth — the token cookie is scoped to .innerai.com so all
    // *.innerai.com subdomains expect it via Cookie header.
    Cookie: `token=${token}`,
    "USER-TOKEN": token,
    "DEVICE-ID": deviceId,
    Origin: "https://app.innerai.com",
    Referer: "https://app.innerai.com/"
  };
  if (email) headers["USER-EMAIL"] = email;
  return headers;
}
async function resolveCredentials(token, credEmail, signal) {
  const key = tokenCacheKey(token);
  const cached = lruTouch(credentialCache, key);
  if (cached) return cached;
  const payload = decodeJwtPayload(token);
  const deviceId = String(
    payload?.device_id ?? payload?.deviceId ?? payload?.["device-id"] ?? payload?.did ?? ""
  ).trim();
  const profileHeaders = {
    Cookie: `token=${token}`,
    "USER-TOKEN": token,
    "User-Agent": INNER_AI_USER_AGENT,
    Origin: "https://app.innerai.com",
    Referer: "https://app.innerai.com/"
  };
  if (deviceId) profileHeaders["DEVICE-ID"] = deviceId;
  let email = "";
  try {
    const profileResp = await fetch(INNER_AI_PROFILE_URL, {
      headers: profileHeaders,
      signal: signal ?? void 0
    });
    if (profileResp.ok) {
      const body = await profileResp.json().catch(() => null);
      const b = body;
      email = String(
        b?.data?.email ?? b?.user?.email ?? b?.profile?.email ?? b?.email ?? ""
      ).trim();
    }
  } catch {
  }
  if (!email && credEmail) email = credEmail;
  if (!email && typeof payload?.sub === "string" && payload.sub.includes("@")) {
    email = payload.sub;
  }
  const creds = { email, deviceId };
  lruSet(credentialCache, key, creds);
  return creds;
}
class InnerAiModelsError extends Error {
  constructor(status, responsePreview) {
    super(`Inner.ai /ai-models returned HTTP ${status}`);
    this.status = status;
    this.responsePreview = responsePreview;
    this.name = "InnerAiModelsError";
  }
  status;
  responsePreview;
}
async function resolveModels(token, deviceId, email, signal) {
  const key = tokenCacheKey(token);
  const cached = lruTouch(modelsCache, key);
  if (cached && Date.now() < cached.expiresAt) return cached.models;
  const resp = await fetch(INNER_AI_MODELS_URL, {
    headers: buildHeaders(token, email, deviceId),
    signal: signal ?? void 0
  });
  if (!resp.ok) {
    const bodyPreview = await resp.text().catch(() => "");
    const err = new InnerAiModelsError(resp.status, bodyPreview.slice(0, 200));
    if (resp.status === 401 || resp.status === 403) {
      credentialCache.delete(tokenCacheKey(token));
    }
    throw err;
  }
  const body = await resp.json().catch(() => null);
  let raw = [];
  if (Array.isArray(body)) {
    raw = body;
  } else if (Array.isArray(body?.data)) {
    raw = body.data;
  } else if (Array.isArray(body?.ai_models)) {
    raw = body.ai_models;
  }
  const planRaw = String(
    decodeJwtPayload(token)?.plan ?? decodeJwtPayload(token)?.tier ?? decodeJwtPayload(token)?.subscription ?? ""
  ).toLowerCase();
  const isUltra = planRaw.includes("ultra") || planRaw.includes("enterprise");
  const isPro = isUltra || planRaw.includes("pro") || planRaw.includes("plus");
  const nonTextPattern = /image|video|audio|img|vid|sound|music|voice|tts|stt|track|clip|avatar|cartoon|flux|stable.diff|recraft|ideogram|leonardo|magnific|bria|seedream|luma|kling|pika|veo|wan-|heygen|did-|vidu|pixverse|sora-|gen-[0-9]|playground|gemini-fal|gamma|lyria|clothes|whisper/i;
  const models = raw.filter((m) => {
    if (m.enable === false || m.unavailable_api) return false;
    if (m.ultra_only && !isUltra) return false;
    if (m.pro_only && !isPro) return false;
    const cats = Array.isArray(m.ai_model_categories) ? m.ai_model_categories : null;
    if (cats && cats.length > 0) {
      return cats.some((c) => String(c.unique_identifier ?? c.name ?? "").toLowerCase() === "text");
    }
    return !nonTextPattern.test(m.llm_model);
  });
  lruSet(modelsCache, key, { models, expiresAt: Date.now() + MODELS_CACHE_TTL_MS });
  return models;
}
function findModel(models, requestedId) {
  if (models.length === 0) return null;
  const lower = requestedId.toLowerCase();
  return models.find((m) => m.llm_model === requestedId) ?? models.find((m) => m.llm_model.toLowerCase() === lower) ?? models.find((m) => m.llm_model.toLowerCase().includes(lower)) ?? null;
}
function buildMessageContent(messages) {
  const parts = [];
  for (const msg of messages) {
    const content = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.filter((c) => c?.type === "text").map((c) => String(c.text ?? "")).join("") : "";
    if (!content.trim()) continue;
    if (msg.role === "system") {
      parts.push(`[Instructions]
${content}`);
    } else if (msg.role === "assistant") {
      parts.push(`[Assistant]
${content}`);
    } else {
      parts.push(content);
    }
  }
  return parts.join("\n\n");
}
function transformInnerAiSSE(upstream, model) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const id = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const created = Math.floor(Date.now() / 1e3);
  let buffer = "";
  let emittedRole = false;
  const chunkEvent = (delta, finishReason) => `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }]
  })}

`;
  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const jsonStr = line.slice(5).trim();
            if (!jsonStr || jsonStr === "[DONE]") continue;
            let data;
            try {
              data = JSON.parse(jsonStr);
            } catch {
              continue;
            }
            const type = String(data.type ?? "");
            const item = String(data.item ?? "");
            if (type === "text") {
              if (!item) continue;
              if (!emittedRole) {
                emittedRole = true;
                controller.enqueue(encoder.encode(chunkEvent({ role: "assistant", content: "" })));
              }
              controller.enqueue(encoder.encode(chunkEvent({ content: item })));
            } else if (type === "end_stream") {
              if (!emittedRole) {
                emittedRole = true;
                controller.enqueue(encoder.encode(chunkEvent({ role: "assistant", content: "" })));
              }
              controller.enqueue(encoder.encode(chunkEvent({}, "stop")));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
              return;
            } else if (type === "missing_credits" || type === "reached_limit" || type === "rate_limit_reached" || type === "rate_limit_longer_reached") {
              const errorMsg = type === "missing_credits" ? "Inner.ai: not enough credits" : type === "reached_limit" ? "Inner.ai: usage limit reached" : "Inner.ai: rate limit reached \u2014 try again later";
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    error: { message: errorMsg, type: "rate_limit_error", code: type }
                  })}

`
                )
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
              return;
            }
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err || "Stream error");
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              error: { message: sanitizeErrorMessage(message), type: "upstream_error" }
            })}

`
          )
        );
      }
      if (!emittedRole) {
        controller.enqueue(encoder.encode(chunkEvent({ role: "assistant", content: "" })));
      }
      controller.enqueue(encoder.encode(chunkEvent({}, "stop")));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
}
class InnerAiStreamError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "InnerAiStreamError";
  }
  status;
  code;
}
async function collectContent(upstream) {
  const decoder = new TextDecoder();
  const reader = upstream.getReader();
  let buffer = "";
  let content = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const jsonStr = line.slice(5).trim();
      if (!jsonStr || jsonStr === "[DONE]") continue;
      let data;
      try {
        data = JSON.parse(jsonStr);
      } catch {
        continue;
      }
      const type = data.type;
      if (type === "text" && typeof data.item === "string") {
        content += data.item;
        continue;
      }
      if (type === "missing_credits" || type === "reached_limit" || type === "rate_limit_reached" || type === "rate_limit_longer_reached") {
        const errorMsg = type === "missing_credits" ? "Inner.ai: not enough credits" : type === "reached_limit" ? "Inner.ai: usage limit reached" : "Inner.ai: rate limit reached \u2014 try again later";
        throw new InnerAiStreamError(429, String(type), errorMsg);
      }
    }
  }
  return content;
}
class InnerAiExecutor extends BaseExecutor {
  constructor() {
    super("inner-ai", { id: "inner-ai", baseUrl: "https://chatapi.innerai.com" });
  }
  async execute(input) {
    const { body, credentials, signal, stream: wantStream } = input;
    const bodyObj = body || {};
    const rawToken = String(credentials?.apiKey ?? "").trim();
    if (!rawToken) {
      return makeErrorResult(
        401,
        "Missing Inner.ai token \u2014 paste your token cookie from DevTools \u2192 Application \u2192 Cookies \u2192 .innerai.com",
        body
      );
    }
    const { token, credEmail } = parseCredential(rawToken);
    let creds;
    try {
      creds = await resolveCredentials(token, credEmail, signal);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to authenticate with Inner.ai";
      credentialCache.delete(tokenCacheKey(token));
      return makeErrorResult(401, message, body);
    }
    const { email, deviceId } = creds;
    const requestedModel = String(bodyObj.model ?? "").trim() || "gpt-4o";
    let models = [];
    try {
      models = await resolveModels(token, deviceId, email, signal);
    } catch (err) {
      if (err instanceof InnerAiModelsError && (err.status === 401 || err.status === 403)) {
        return makeErrorResult(
          err.status,
          "Inner.ai /ai-models authentication failed \u2014 re-paste your token cookie",
          body
        );
      }
      console.warn(
        `[InnerAI] /ai-models fetch failed (status=${err instanceof InnerAiModelsError ? err.status : "n/a"}) \u2014 falling back to synthetic model entry`
      );
    }
    const modelEntry = findModel(models, requestedModel) ?? {
      id: "",
      llm_model: requestedModel
    };
    const rawMessages = Array.isArray(bodyObj.messages) ? bodyObj.messages : [];
    const { hasTools, requestedTools, effectiveMessages } = prepareToolMessages(
      bodyObj,
      rawMessages
    );
    const messages = effectiveMessages;
    const messageContent = buildMessageContent(messages);
    if (!messageContent.trim()) {
      return makeErrorResult(400, "No message content to send", body);
    }
    const innerAiBody = {
      message: messageContent,
      session_id: crypto.randomUUID(),
      context_type: "no_context",
      ai_model: {
        id: modelEntry?.id || void 0,
        llm_model: modelEntry?.llm_model ?? requestedModel
      },
      is_extension: false,
      env: "production",
      temporary: true,
      use_web_search: false,
      knowledge_list: []
    };
    const reqHeaders = buildHeaders(token, email, deviceId);
    let upstream;
    try {
      upstream = await fetch(INNER_AI_CHAT_URL, {
        method: "POST",
        headers: reqHeaders,
        body: JSON.stringify(innerAiBody),
        signal: signal ?? void 0
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Request failed";
      return makeErrorResult(
        502,
        `Inner.ai request failed: ${sanitizeErrorMessage(message)}`,
        body
      );
    }
    if (upstream.status === 401 || upstream.status === 403) {
      credentialCache.delete(tokenCacheKey(token));
      return makeErrorResult(
        upstream.status,
        "Inner.ai authentication failed \u2014 re-paste your token cookie",
        body
      );
    }
    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      return makeErrorResult(
        upstream.status,
        `Inner.ai returned HTTP ${upstream.status}: ${sanitizeErrorMessage(errText)}`,
        body
      );
    }
    if (!upstream.body) {
      return makeErrorResult(502, "Inner.ai returned an empty response", body);
    }
    const resolvedModel = modelEntry?.llm_model ?? requestedModel;
    if (wantStream !== false) {
      return {
        response: new Response(transformInnerAiSSE(upstream.body, resolvedModel), {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive"
          }
        }),
        url: INNER_AI_CHAT_URL,
        headers: reqHeaders,
        transformedBody: innerAiBody
      };
    }
    let content;
    try {
      content = await collectContent(upstream.body);
    } catch (err) {
      if (err instanceof InnerAiStreamError) {
        return makeErrorResult(err.status, err.message, body);
      }
      throw err;
    }
    const completionId = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (hasTools) {
      const {
        content: cleaned,
        toolCalls,
        finishReason
      } = buildToolAwareResult(content, requestedTools, "inner");
      if (toolCalls) {
        return {
          response: new Response(
            JSON.stringify({
              id: completionId,
              object: "chat.completion",
              created: Math.floor(Date.now() / 1e3),
              model: resolvedModel,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: null, tool_calls: toolCalls },
                  finish_reason: finishReason
                }
              ]
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ),
          url: INNER_AI_CHAT_URL,
          headers: reqHeaders,
          transformedBody: innerAiBody
        };
      }
      content = cleaned;
    }
    return {
      response: new Response(
        JSON.stringify({
          id: completionId,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1e3),
          model: resolvedModel,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content },
              finish_reason: "stop"
            }
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        }),
        { headers: { "Content-Type": "application/json" } }
      ),
      url: INNER_AI_CHAT_URL,
      headers: reqHeaders,
      transformedBody: innerAiBody
    };
  }
}
export {
  InnerAiExecutor,
  findModel
};
