import { BaseExecutor } from "./base.ts";
import { makeExecutorErrorResult as makeErrorResult } from "../utils/error.js";
import { prepareToolMessages, buildToolAwareResult } from "../translator/webTools.ts";
import { buildQwenCookieHeader, extractQwenToken } from '../../lib/providers/webCookieAuth.js';
const BASE_URL = "https://chat.qwen.ai";
const CHATS_NEW_URL = `${BASE_URL}/api/v2/chats/new`;
const CHAT_COMPLETIONS_URL = `${BASE_URL}/api/v2/chat/completions`;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const BX_VERSION = "2.5.36";
const BX_UMIDTOKEN_FALLBACK = "T2gA0000000000000000000000000000000000000000";
const QWEN_SPA_VERSION = "0.2.66";
const MODEL_ALIASES = {
  // Legacy OmniRoute ids → current upstream catalog (GET /api/models).
  "qwen-plus": "qwen3.7-plus",
  "qwen-max": "qwen3.7-max",
  "qwen-turbo": "qwen3.6-plus",
  "qwen3-plus": "qwen3.7-plus",
  "qwen3-max": "qwen3.7-max",
  "qwen3-flash": "qwen3.6-plus",
  // Note: `qwen3-coder-plus` is a real upstream model id (Qwen3-Coder) and
  // must NOT be aliased — the previous `"qwen3-coder-plus": "qwen3.7-max"`
  // entry silently rewrote valid coder requests to the wrong model.
  "qwen3-coder-flash": "qwen3.6-plus",
  qwen: "qwen3.7-max",
  qwen3: "qwen3.7-max"
};
const DEFAULT_MODEL = "qwen3.7-max";
function mapModel(modelId) {
  return MODEL_ALIASES[modelId] || modelId;
}
function uuid() {
  return crypto.randomUUID();
}
function isWafResponse(status, contentType, bodyText) {
  if (contentType.includes("text/html")) return true;
  if (status === 504) return true;
  return /aliyun_waf|baxia|<html/i.test(bodyText);
}
const WAF_ERROR_MESSAGE = "Qwen session expired or blocked by Alibaba's WAF. Re-login at https://chat.qwen.ai and paste a fresh full Cookie header (must include cna, ssxmod_itna and token) \u2014 a bearer token alone is no longer accepted by the v2 endpoint.";
class QwenWebExecutor extends BaseExecutor {
  constructor() {
    super("qwen-web", { id: "qwen-web", baseUrl: BASE_URL });
  }
  buildHeaders(token, cookieHeader, chatId) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "*/*",
      "User-Agent": USER_AGENT,
      Origin: BASE_URL,
      Referer: chatId ? `${BASE_URL}/c/${chatId}` : `${BASE_URL}/`,
      source: "web",
      version: QWEN_SPA_VERSION,
      "x-request-id": uuid(),
      "bx-v": BX_VERSION,
      "bx-umidtoken": BX_UMIDTOKEN_FALLBACK
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (cookieHeader) headers["Cookie"] = cookieHeader;
    return headers;
  }
  async execute(input) {
    const { body, credentials, signal, stream: wantStream } = input;
    const bodyObj = body || {};
    const rawCred = String(credentials?.apiKey ?? "").trim();
    const cookieHeader = buildQwenCookieHeader(rawCred);
    let token = extractQwenToken(rawCred);
    if (!token && credentials?.accessToken) token = String(credentials.accessToken).trim();
    const messages = bodyObj.messages || [];
    const requestedModel = bodyObj.model || DEFAULT_MODEL;
    const modelId = mapModel(requestedModel);
    const { hasTools, requestedTools, effectiveMessages } = prepareToolMessages(bodyObj, messages);
    const prompt = this.foldMessages(effectiveMessages);
    let chatId;
    try {
      const newChatRes = await fetch(CHATS_NEW_URL, {
        method: "POST",
        headers: this.buildHeaders(token, cookieHeader),
        body: JSON.stringify({
          title: "New Chat",
          models: [modelId],
          chat_mode: "normal",
          chat_type: "t2t",
          timestamp: Date.now()
        }),
        signal
      });
      const ct2 = newChatRes.headers.get("content-type") || "";
      if (!newChatRes.ok || ct2.includes("text/html")) {
        const text = await newChatRes.text().catch(() => "");
        if (isWafResponse(newChatRes.status, ct2, text)) {
          return makeErrorResult(401, WAF_ERROR_MESSAGE, body, CHATS_NEW_URL);
        }
        return makeErrorResult(
          newChatRes.status || 502,
          `Qwen create-chat failed: ${text.slice(0, 300)}`,
          body,
          CHATS_NEW_URL
        );
      }
      const data = await newChatRes.json();
      chatId = data?.data?.id ?? "";
      if (!chatId) {
        return makeErrorResult(502, "Qwen create-chat returned no chat id", body, CHATS_NEW_URL);
      }
    } catch (err) {
      return makeErrorResult(
        502,
        `Qwen create-chat error: ${err instanceof Error ? err.message : "unknown"}`,
        body,
        CHATS_NEW_URL
      );
    }
    const completionUrl = `${CHAT_COMPLETIONS_URL}?chat_id=${chatId}`;
    const msgPayload = this.buildMessagePayload(chatId, modelId, prompt, requestedModel);
    let upstream;
    try {
      upstream = await fetch(completionUrl, {
        method: "POST",
        headers: this.buildHeaders(token, cookieHeader, chatId),
        body: JSON.stringify(msgPayload),
        signal
      });
    } catch (err) {
      return makeErrorResult(
        502,
        `Qwen completion fetch failed: ${err instanceof Error ? err.message : "unknown"}`,
        body,
        completionUrl
      );
    }
    const ct = upstream.headers.get("content-type") || "";
    if (!upstream.ok || ct.includes("text/html")) {
      const errText = await upstream.text().catch(() => "");
      if (isWafResponse(upstream.status, ct, errText)) {
        return makeErrorResult(401, WAF_ERROR_MESSAGE, body, completionUrl);
      }
      return makeErrorResult(
        upstream.status || 502,
        `Qwen error: ${errText.slice(0, 300)}`,
        body,
        completionUrl
      );
    }
    if (!wantStream) {
      const { content } = await this.collectStream(upstream);
      const finalText = content;
      if (hasTools) {
        const {
          content: toolContent,
          toolCalls,
          finishReason
        } = buildToolAwareResult(finalText, requestedTools, "qwen");
        const message = { role: "assistant", content: toolContent };
        if (toolCalls) {
          message.tool_calls = toolCalls;
          message.content = null;
        }
        return this.jsonResponse(modelId, message, finishReason, completionUrl, msgPayload);
      }
      return this.jsonResponse(
        modelId,
        { role: "assistant", content: finalText },
        "stop",
        completionUrl,
        msgPayload
      );
    }
    const stream = this.buildClientStream(upstream, modelId, hasTools, requestedTools, signal);
    return {
      response: new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive"
        }
      }),
      url: completionUrl,
      headers: this.buildHeaders(token, cookieHeader, chatId),
      transformedBody: msgPayload
    };
  }
  foldMessages(messages) {
    let systemContent = "";
    let userContent = "";
    for (const m of messages) {
      const text = String(m.content ?? "");
      if (m.role === "system") {
        systemContent += (systemContent ? "\n\n" : "") + text;
      } else if (m.role === "user") {
        userContent = text;
      }
    }
    return systemContent ? `${systemContent}

User: ${userContent}` : userContent;
  }
  buildMessagePayload(chatId, modelId, prompt, requestedModel) {
    const fid = uuid();
    const enableThinking = /think|reason|r1/i.test(requestedModel);
    const featureConfig = {
      thinking_enabled: enableThinking,
      output_schema: "phase",
      auto_thinking: enableThinking,
      research_mode: "normal",
      auto_search: false
    };
    return {
      stream: true,
      incremental_output: true,
      chat_id: chatId,
      chat_mode: "normal",
      model: modelId,
      parent_id: null,
      messages: [
        {
          fid,
          parentId: null,
          childrenIds: [],
          role: "user",
          content: prompt,
          user_action: "chat",
          files: [],
          timestamp: Math.floor(Date.now() / 1e3),
          models: [modelId],
          chat_type: "t2t",
          feature_config: featureConfig,
          sub_chat_type: "t2t",
          parent_id: null
        }
      ]
    };
  }
  /** Read the whole upstream SSE stream, returning the joined answer + reasoning. */
  async collectStream(upstream) {
    const reader = upstream.body?.getReader();
    const decoder = new TextDecoder();
    let content = "";
    let reasoning = "";
    if (!reader) return { content, reasoning };
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const delta = parseSseDelta(line);
          if (!delta) continue;
          if (delta.kind === "answer") content += delta.text;
          else if (delta.kind === "think") reasoning += delta.text;
        }
      }
    } catch {
    }
    return { content, reasoning };
  }
  /** Transform the Qwen phase SSE into OpenAI chat.completion.chunk SSE. */
  buildClientStream(upstream, modelId, hasTools, requestedTools, signal) {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const id = `chatcmpl-qwen-${Date.now()}`;
    const created = Math.floor(Date.now() / 1e3);
    const emitChunk = (delta, finishReason) => `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model: modelId,
      choices: [{ index: 0, delta, finish_reason: finishReason }]
    })}

`;
    return new ReadableStream({
      async start(controller) {
        const reader = upstream.body?.getReader();
        if (!reader) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }
        let buffer = "";
        let fullContent = "";
        controller.enqueue(encoder.encode(emitChunk({ role: "assistant", content: "" }, null)));
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              const delta = parseSseDelta(line);
              if (!delta || !delta.text) continue;
              if (delta.kind === "answer") {
                fullContent += delta.text;
                if (!hasTools) {
                  controller.enqueue(encoder.encode(emitChunk({ content: delta.text }, null)));
                }
              } else if (delta.kind === "think" && !hasTools) {
                controller.enqueue(
                  encoder.encode(emitChunk({ reasoning_content: delta.text }, null))
                );
              }
            }
          }
        } catch (err) {
          if (!signal?.aborted) {
            controller.error(err);
            return;
          }
        }
        if (hasTools) {
          const { content, toolCalls, finishReason } = buildToolAwareResult(
            fullContent,
            requestedTools,
            "qwen"
          );
          const delta = toolCalls ? { role: "assistant", content: null, tool_calls: toolCalls } : { role: "assistant", content };
          controller.enqueue(encoder.encode(emitChunk(delta, null)));
          controller.enqueue(encoder.encode(emitChunk({}, finishReason)));
        } else {
          controller.enqueue(encoder.encode(emitChunk({}, "stop")));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    });
  }
  jsonResponse(modelId, message, finishReason, url, transformedBody) {
    return {
      response: new Response(
        JSON.stringify({
          id: `chatcmpl-qwen-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1e3),
          model: modelId,
          choices: [{ index: 0, message, finish_reason: finishReason }]
        }),
        { headers: { "Content-Type": "application/json" } }
      ),
      url,
      headers: {},
      transformedBody
    };
  }
}
function parseSseDelta(line) {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  const delta = parsed?.choices?.[0]?.delta;
  if (!delta) return null;
  const phase = delta.phase;
  const content = typeof delta.content === "string" ? delta.content : "";
  if (phase === "think" || phase === "thinking_summary") {
    return { kind: "think", text: content };
  }
  if (phase === "answer" || phase === null || phase === void 0) {
    return { kind: "answer", text: content };
  }
  return null;
}
export {
  QwenWebExecutor
};
