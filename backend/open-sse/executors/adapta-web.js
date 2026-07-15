import { BaseExecutor } from "./base.ts";
import { prepareToolMessages, buildToolAwareResult } from "../translator/webTools.ts";
import { sanitizeErrorMessage } from "../utils/error.js";
const ADAPTA_APP_URL = "https://agent.adapta.one";
const ADAPTA_CLERK_URL = "https://clerk.agent.adapta.one";
const ADAPTA_STREAM_URL = `${ADAPTA_APP_URL}/api/chat/stream/v1`;
const DEFAULT_AI_MODEL_ID = 14;
const MODEL_ID_MAP = {
  "adapta-one": 14,
  "adapta-gpt": 14,
  "adapta-claude": 14,
  "adapta-gemini": 14,
  "adapta-grok": 14,
  "adapta-deepseek": 14,
  "adapta-llama": 14
};
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const sessionCache = /* @__PURE__ */ new Map();
function cacheKey(clientJwt) {
  return clientJwt.slice(0, 32);
}
function cachedJwt(clientJwt) {
  const entry = sessionCache.get(cacheKey(clientJwt));
  if (!entry) return null;
  if (Date.now() >= entry.jwtExpiresAt - 3e4) return null;
  return entry.jwt;
}
function storeSession(clientJwt, sessionId, jwt, expMs) {
  sessionCache.set(cacheKey(clientJwt), { sessionId, jwt, jwtExpiresAt: expMs });
}
function extractClientJwt(rawApiKey) {
  const trimmed = rawApiKey.trim();
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx > 0 && !trimmed.startsWith("eyJ")) {
    return trimmed.slice(eqIdx + 1).trim();
  }
  return trimmed;
}
function jwtExpMs(jwt) {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return 0;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(b64));
    return typeof payload.exp === "number" ? payload.exp * 1e3 : 0;
  } catch {
    return 0;
  }
}
function makeErrorResponse(status, message) {
  return new Response(
    JSON.stringify({ error: { message, type: "upstream_error", code: `HTTP_${status}` } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}
async function getSessionId(clientJwt, signal, log) {
  const resp = await fetch(`${ADAPTA_CLERK_URL}/v1/client`, {
    headers: {
      Cookie: `__client=${clientJwt}`,
      "User-Agent": USER_AGENT,
      Origin: ADAPTA_APP_URL
    },
    signal: signal ?? void 0
  });
  if (!resp.ok) {
    throw new Error(`Clerk /v1/client returned HTTP ${resp.status} \u2014 check your __client cookie`);
  }
  const body = await resp.json();
  const sessions = body?.response?.sessions ?? [];
  const active = sessions.find((s) => s.status === "active");
  if (!active?.id) {
    throw new Error(
      "No active Clerk session found \u2014 your __client cookie may be expired or invalid"
    );
  }
  log?.info?.("ADAPTA-WEB", `Got session ID: ${active.id}`);
  return active.id;
}
async function refreshSessionJwt(clientJwt, sessionId, signal, log) {
  const resp = await fetch(`${ADAPTA_CLERK_URL}/v1/client/sessions/${sessionId}/tokens`, {
    method: "POST",
    headers: {
      Cookie: `__client=${clientJwt}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      Origin: ADAPTA_APP_URL
    },
    signal: signal ?? void 0
  });
  if (!resp.ok) {
    throw new Error(`Clerk token refresh returned HTTP ${resp.status}`);
  }
  const body = await resp.json();
  const jwt = body?.jwt;
  if (typeof jwt !== "string" || !jwt.startsWith("eyJ")) {
    throw new Error("Clerk token refresh did not return a valid JWT");
  }
  log?.info?.("ADAPTA-WEB", `Got fresh session JWT (${jwt.length} chars)`);
  return jwt;
}
async function getSessionJwt(clientJwt, signal, log) {
  const cached = cachedJwt(clientJwt);
  if (cached) {
    log?.info?.("ADAPTA-WEB", "Using cached session JWT");
    return cached;
  }
  const sessionId = await getSessionId(clientJwt, signal, log);
  const jwt = await refreshSessionJwt(clientJwt, sessionId, signal, log);
  storeSession(clientJwt, sessionId, jwt, jwtExpMs(jwt) || Date.now() + 55e3);
  return jwt;
}
function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((c) => c.type === "text").map((c) => String(c.text ?? "")).join("");
  }
  return String(content ?? "");
}
function buildAdaptaMessages(messages) {
  let systemText = "";
  const rest = [];
  for (const msg of messages) {
    const role = msg.role === "developer" ? "system" : msg.role;
    if (role === "system") {
      systemText += (systemText ? "\n" : "") + extractText(msg.content);
    } else {
      rest.push(msg);
    }
  }
  const adapted = [];
  let systemInjected = false;
  for (const msg of rest) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const text = extractText(msg.content);
    if (!text.trim()) continue;
    if (!systemInjected && systemText && msg.role === "user") {
      adapted.push({
        role: "user",
        parts: [{ type: "text", text: `${systemText}

${text}` }]
      });
      systemInjected = true;
    } else {
      adapted.push({ role: msg.role, parts: [{ type: "text", text }] });
    }
  }
  return adapted;
}
function transformStream(adaptaStream, model) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const id = `chatcmpl-adp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const created = Math.floor(Date.now() / 1e3);
  let roleEmitted = false;
  return new ReadableStream({
    async start(controller) {
      const reader = adaptaStream.getReader();
      let buffer = "";
      const emit = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}

`));
      const chunk = (delta, finish) => emit({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish ?? null }]
      });
      const ensureRole = () => {
        if (!roleEmitted) {
          roleEmitted = true;
          chunk({ role: "assistant", content: "" });
        }
      };
      const finalize = () => {
        ensureRole();
        chunk({}, "stop");
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6).trim();
            if (!payload) continue;
            let event;
            try {
              event = JSON.parse(payload);
            } catch {
              continue;
            }
            const type = event.type;
            if (type === "text-delta") {
              const delta = event.delta;
              if (event.id === "quick-response") continue;
              if (typeof delta === "string" && delta.length > 0) {
                ensureRole();
                chunk({ content: delta });
              }
            } else if (type === "text-end") {
              if (event.id === "quick-response") continue;
            } else if (type === "error") {
              const errText = String(event.errorText ?? "Adapta upstream error");
              ensureRole();
              chunk({ content: `

[Erro: ${errText}]` });
              finalize();
              return;
            } else if (type === "done" || type === "end") {
              finalize();
              return;
            }
          }
        }
      } catch {
      }
      finalize();
    }
  });
}
class AdaptaWebExecutor extends BaseExecutor {
  constructor() {
    super("adapta-web", { baseUrl: ADAPTA_STREAM_URL });
  }
  async testConnection(credentials, signal) {
    try {
      const rawKey = String(credentials?.apiKey ?? "");
      if (!rawKey) return false;
      const clientJwt = extractClientJwt(rawKey);
      const sessionId = await getSessionId(clientJwt, signal);
      return !!sessionId;
    } catch {
      return false;
    }
  }
  async execute({ model, body, stream, credentials, signal, log }) {
    const bodyObj = body ?? {};
    const messages = Array.isArray(bodyObj.messages) ? bodyObj.messages : [];
    const { hasTools, requestedTools, effectiveMessages } = prepareToolMessages(bodyObj, messages);
    const rawKey = String(credentials?.apiKey ?? "");
    if (!rawKey) {
      return {
        response: makeErrorResponse(
          401,
          "Missing Adapta credentials \u2014 paste your __client cookie from .clerk.agent.adapta.one"
        ),
        url: ADAPTA_STREAM_URL,
        headers: {},
        transformedBody: body
      };
    }
    const clientJwt = extractClientJwt(rawKey);
    let sessionJwt;
    try {
      log?.info?.("ADAPTA-WEB", "Obtaining session JWT via Clerk...");
      sessionJwt = await getSessionJwt(clientJwt, signal, log);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.warn?.("ADAPTA-WEB", `Auth failed: ${msg}`);
      return {
        response: makeErrorResponse(401, `Adapta auth failed: ${sanitizeErrorMessage(msg)}`),
        url: ADAPTA_STREAM_URL,
        headers: {},
        transformedBody: body
      };
    }
    const aiModelId = MODEL_ID_MAP[model] ?? DEFAULT_AI_MODEL_ID;
    const adaptaMessages = buildAdaptaMessages(effectiveMessages);
    if (adaptaMessages.length === 0) {
      return {
        response: makeErrorResponse(400, "No messages provided"),
        url: ADAPTA_STREAM_URL,
        headers: {},
        transformedBody: body
      };
    }
    const requestPayload = {
      messages: adaptaMessages,
      aiModelId
    };
    const headers = {
      Authorization: `Bearer ${sessionJwt}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "User-Agent": USER_AGENT,
      Origin: ADAPTA_APP_URL,
      Referer: `${ADAPTA_APP_URL}/agentic-chat`
    };
    log?.info?.(
      "ADAPTA-WEB",
      `POST ${ADAPTA_STREAM_URL} | model=${model} aiModelId=${aiModelId} msgs=${adaptaMessages.length}`
    );
    const resp = await fetch(ADAPTA_STREAM_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(requestPayload),
      signal: signal ?? void 0
    });
    if (!resp.ok) {
      let errMsg = `Adapta error HTTP ${resp.status}`;
      if (resp.status === 401 || resp.status === 403) {
        errMsg = "Adapta session expired or invalid \u2014 re-paste your __client cookie from .clerk.agent.adapta.one";
        sessionCache.delete(cacheKey(clientJwt));
      } else if (resp.status === 429) {
        errMsg = "Adapta rate limited \u2014 wait and retry";
      }
      log?.warn?.("ADAPTA-WEB", errMsg);
      return {
        response: makeErrorResponse(resp.status, errMsg),
        url: ADAPTA_STREAM_URL,
        headers,
        transformedBody: requestPayload
      };
    }
    if (stream !== false) {
      return {
        response: new Response(transformStream(resp.body, model), {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive"
          }
        }),
        url: ADAPTA_STREAM_URL,
        headers,
        transformedBody: requestPayload
      };
    }
    const decoder = new TextDecoder();
    const reader = resp.body.getReader();
    let buf = "";
    let fullText = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.type === "text-delta" && ev.id !== "quick-response") {
              fullText += String(ev.delta ?? "");
            }
          } catch {
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (hasTools) {
      const { content, toolCalls, finishReason } = buildToolAwareResult(
        fullText,
        requestedTools,
        "adp"
      );
      if (toolCalls) {
        return {
          response: new Response(
            JSON.stringify({
              id: `chatcmpl-adp-${Date.now()}`,
              object: "chat.completion",
              created: Math.floor(Date.now() / 1e3),
              model,
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
          url: ADAPTA_STREAM_URL,
          headers,
          transformedBody: requestPayload
        };
      }
      return {
        response: new Response(
          JSON.stringify({
            id: `chatcmpl-adp-${Date.now()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1e3),
            model,
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
        url: ADAPTA_STREAM_URL,
        headers,
        transformedBody: requestPayload
      };
    }
    return {
      response: new Response(
        JSON.stringify({
          id: `chatcmpl-adp-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1e3),
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: fullText },
              finish_reason: "stop"
            }
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      ),
      url: ADAPTA_STREAM_URL,
      headers,
      transformedBody: requestPayload
    };
  }
}
export {
  AdaptaWebExecutor
};
