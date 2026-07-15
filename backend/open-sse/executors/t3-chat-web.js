import { BaseExecutor } from "./base.ts";
import { errorResponse } from "../utils/error.js";
import { prepareToolMessages, buildToolAwareResult } from "../translator/webTools.ts";
const T3_CHAT_BASE = "https://t3.chat";
const SERVER_FN_PREFIX = `${T3_CHAT_BASE}/_serverFn/`;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const TSS_ACCEPT = "application/x-tss-framed, application/x-ndjson, application/json";
function parseT3Credentials(creds) {
  const rawCreds = typeof creds === "object" && creds !== null ? creds : {};
  const raw = String(rawCreds.apiKey ?? rawCreds.accessToken ?? "").trim();
  if (!raw) {
    return { cookieHeader: "", cookies: "", convexSessionId: "" };
  }
  let cookieHeader = raw;
  let convexSessionId = "";
  if (raw.includes("convexSessionId") || raw.includes("convex-session-id")) {
    const parts = raw.split(/[,;\n]/).map((s) => s.trim());
    const cookieParts = [];
    for (const part of parts) {
      if (part.startsWith("convexSessionId=") || part.startsWith("convex-session-id=")) {
        convexSessionId = part.split("=").slice(1).join("=");
      } else if (part.startsWith("cookies=")) {
        cookieParts.push(part.slice("cookies=".length));
      } else if (part.includes("=")) {
        cookieParts.push(part);
      }
    }
    if (cookieParts.length) cookieHeader = cookieParts.join("; ");
  }
  const finalCookie = convexSessionId && !cookieHeader.includes("convex-session-id") ? `${cookieHeader}; convex-session-id=${convexSessionId}` : cookieHeader;
  if (!convexSessionId) {
    const m = finalCookie.match(/convex-session-id=([^;]+)/);
    if (m) convexSessionId = m[1].trim();
  }
  return { cookieHeader: finalCookie, cookies: cookieHeader, convexSessionId };
}
function validateT3Credentials(creds) {
  if (!creds) return false;
  return typeof creds.cookieHeader === "string" && creds.cookieHeader.length > 0 && typeof creds.convexSessionId === "string" && creds.convexSessionId.length > 0;
}
function buildErrorResponse(status, message) {
  return errorResponse(status, message);
}
function buildServerFnHeaders(cookieHeader) {
  return {
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
    Accept: TSS_ACCEPT,
    Cookie: cookieHeader,
    Referer: `${T3_CHAT_BASE}/`,
    Origin: T3_CHAT_BASE
  };
}
function transformTSSStream(upstreamStream, model) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const id = `chatcmpl-t3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const created = Math.floor(Date.now() / 1e3);
  let emittedRole = false;
  return new ReadableStream(
    {
      async start(controller) {
        const reader = upstreamStream.getReader();
        let buffer = "";
        const emit = (obj) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}

`));
        };
        const chunk = (delta, finish) => {
          emit({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta, finish_reason: finish ?? null }]
          });
        };
        const close = () => {
          if (!emittedRole) {
            emittedRole = true;
            chunk({ role: "assistant", content: "" });
          }
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
            buffer = lines.pop() || "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              const payload = trimmed.startsWith("data: ") ? trimmed.slice(6).trim() : trimmed;
              if (payload === "[DONE]") {
                close();
                return;
              }
              let data;
              try {
                data = JSON.parse(payload);
              } catch {
                continue;
              }
              const textContent = extractTextFromTSS(data);
              if (typeof textContent === "string" && textContent.length > 0) {
                if (!emittedRole) {
                  emittedRole = true;
                  chunk({ role: "assistant", content: "" });
                }
                chunk({ content: textContent });
              }
              if (isTSSDone(data)) {
                close();
                return;
              }
            }
          }
        } catch {
        }
        close();
      }
    },
    { highWaterMark: 16384 }
  );
}
function extractTextFromTSS(data) {
  if (typeof data?.text === "string") return data.text;
  if (typeof data?.delta === "string") return data.delta;
  if (typeof data?.content === "string") return data.content;
  const p = data?.p;
  if (p?.k && p?.v && Array.isArray(p.k) && Array.isArray(p.v)) {
    for (let i = 0; i < p.k.length; i++) {
      if (p.k[i] === "content" || p.k[i] === "text" || p.k[i] === "delta") {
        const val = p.v[i];
        if (typeof val === "string") return val;
        if (val?.t === 2 && typeof val?.s === "string") return val.s;
      }
    }
  }
  if (data?.t === 2 && typeof data?.s === "string") return data.s;
  return null;
}
function isTSSDone(data) {
  const d = data;
  return d?.type === "done" || d?.done === true || d?.status === "complete" || d?.finish_reason === "stop";
}
async function collectStreamContent(upstreamStream) {
  const decoder = new TextDecoder();
  const reader = upstreamStream.getReader();
  let buffer = "";
  const parts = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const payload = trimmed.startsWith("data: ") ? trimmed.slice(6).trim() : trimmed;
      if (payload === "[DONE]") break;
      try {
        const data = JSON.parse(payload);
        const text = extractTextFromTSS(data);
        if (typeof text === "string") parts.push(text);
      } catch {
      }
    }
  }
  return parts.join("");
}
class T3ChatWebExecutor extends BaseExecutor {
  constructor() {
    super("t3-web", { baseUrl: T3_CHAT_BASE });
  }
  async testConnection(credentials, signal) {
    try {
      const parsed = parseT3Credentials(credentials);
      if (!validateT3Credentials(parsed)) return false;
      const resp = await fetch(T3_CHAT_BASE, {
        method: "HEAD",
        headers: {
          "User-Agent": USER_AGENT,
          Cookie: parsed.cookieHeader
        },
        signal
      });
      return resp.status < 500;
    } catch {
      return false;
    }
  }
  async execute({ model, body, stream, credentials, signal, log }) {
    const bodyObj = body || {};
    const rawMessages = Array.isArray(bodyObj.messages) ? bodyObj.messages : [];
    const { hasTools, requestedTools, effectiveMessages } = prepareToolMessages(
      bodyObj,
      rawMessages
    );
    const parsed = parseT3Credentials(credentials);
    if (!validateT3Credentials(parsed)) {
      return {
        response: buildErrorResponse(
          400,
          "t3.chat credentials invalid: paste your full Cookie header (including convex-session-id) from t3.chat."
        ),
        url: `${SERVER_FN_PREFIX}...`,
        headers: {},
        transformedBody: body
      };
    }
    const cookieHeader = parsed.cookieHeader;
    const headers = buildServerFnHeaders(cookieHeader);
    try {
      const requestPayload = {
        model,
        messages: effectiveMessages,
        stream: stream !== false
      };
      const completionUrl = `${T3_CHAT_BASE}/api/chat`;
      log?.info?.("T3-CHAT-WEB", `POST ${completionUrl} model=${model}`);
      const resp = await fetch(completionUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(requestPayload),
        signal
      });
      if (!resp.ok) {
        const status = resp.status;
        let errMsg = `t3.chat API error (${status})`;
        if (status === 401 || status === 403) {
          errMsg = "t3.chat session expired or unauthorized \u2014 re-paste your cookies and convex-session-id.";
        } else if (status === 429) {
          errMsg = "t3.chat rate limited. Wait and retry.";
        }
        log?.warn?.("T3-CHAT-WEB", errMsg);
        return {
          response: buildErrorResponse(status, errMsg),
          url: completionUrl,
          headers,
          transformedBody: requestPayload
        };
      }
      const ct = resp.headers.get("content-type") || "";
      if (ct.includes("application/json") && !ct.includes("ndjson")) {
        const json = await resp.json();
        if (json?.error) {
          const errMsg = `t3.chat error: ${json.error?.message ?? JSON.stringify(json.error)}`;
          log?.warn?.("T3-CHAT-WEB", errMsg);
          return {
            response: buildErrorResponse(502, errMsg),
            url: completionUrl,
            headers,
            transformedBody: requestPayload
          };
        }
        if (json?.choices) {
          return {
            response: new Response(JSON.stringify(json), {
              status: 200,
              headers: { "Content-Type": "application/json" }
            }),
            url: completionUrl,
            headers,
            transformedBody: requestPayload
          };
        }
        const content = extractTextFromTSS(json) ?? json?.message?.content ?? "";
        const openaiResponse2 = {
          id: `chatcmpl-t3-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1e3),
          model: model || "unknown",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: String(content) },
              finish_reason: "stop"
            }
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        };
        return {
          response: new Response(JSON.stringify(openaiResponse2), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }),
          url: completionUrl,
          headers,
          transformedBody: requestPayload
        };
      }
      if (!resp.body) {
        return {
          response: buildErrorResponse(502, "t3.chat returned an empty response body"),
          url: completionUrl,
          headers,
          transformedBody: requestPayload
        };
      }
      if (stream !== false) {
        const openaiStream = transformTSSStream(resp.body, model || "unknown");
        return {
          response: new Response(openaiStream, {
            status: 200,
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }
          }),
          url: completionUrl,
          headers,
          transformedBody: requestPayload
        };
      }
      const rawContent = await collectStreamContent(resp.body);
      if (hasTools) {
        const { content, toolCalls, finishReason } = buildToolAwareResult(
          rawContent,
          requestedTools,
          "t3"
        );
        if (toolCalls) {
          return {
            response: new Response(
              JSON.stringify({
                id: `chatcmpl-t3-${Date.now()}`,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1e3),
                model: model || "unknown",
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
            url: completionUrl,
            headers,
            transformedBody: requestPayload
          };
        }
        const openaiResponse2 = {
          id: `chatcmpl-t3-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1e3),
          model: model || "unknown",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        };
        return {
          response: new Response(JSON.stringify(openaiResponse2), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }),
          url: completionUrl,
          headers,
          transformedBody: requestPayload
        };
      }
      const openaiResponse = {
        id: `chatcmpl-t3-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1e3),
        model: model || "unknown",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: rawContent },
            finish_reason: "stop"
          }
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      };
      return {
        response: new Response(JSON.stringify(openaiResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }),
        url: completionUrl,
        headers,
        transformedBody: requestPayload
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.error?.("T3-CHAT-WEB", `Execute failed: ${msg}`);
      if (err instanceof DOMException && err.name === "AbortError") {
        return {
          response: buildErrorResponse(499, "Request cancelled"),
          url: `${SERVER_FN_PREFIX}...`,
          headers: {},
          transformedBody: body
        };
      }
      return {
        response: buildErrorResponse(502, `t3.chat connection error: ${msg}`),
        url: `${SERVER_FN_PREFIX}...`,
        headers,
        transformedBody: body
      };
    }
  }
}
const t3ChatWebExecutor = new T3ChatWebExecutor();
export {
  T3ChatWebExecutor,
  T3_CHAT_BASE,
  parseT3Credentials,
  t3ChatWebExecutor,
  validateT3Credentials
};
