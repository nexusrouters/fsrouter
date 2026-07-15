import { BaseExecutor } from "./base.ts";
import { makeExecutorErrorResult as makeErrorResult, sanitizeErrorMessage } from "../utils/error.js";
import { extractKimiJwt } from "@/lib/providers/webCookieAuth";
const BASE_URL = "https://www.kimi.com";
const CHAT_URL = `${BASE_URL}/apiv2/kimi.gateway.chat.v1.ChatService/Chat`;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
function resolveModelConfig(modelId) {
  if (modelId === "k2d6-thinking") return { scenario: "SCENARIO_K2D5", thinking: true };
  return { scenario: "SCENARIO_K2D5", thinking: false };
}
function frameConnectMessage(json) {
  const payload = new TextEncoder().encode(json);
  const framed = new Uint8Array(5 + payload.length);
  framed[0] = 0;
  const len = payload.length;
  framed[1] = len >>> 24 & 255;
  framed[2] = len >>> 16 & 255;
  framed[3] = len >>> 8 & 255;
  framed[4] = len & 255;
  framed.set(payload, 5);
  return framed;
}
const MAX_FRAME_LEN = 8 * 1024 * 1024;
function decodeConnectFrame(buf, byteOffset) {
  if (byteOffset + 5 > buf.length) return { consumed: 0, frame: null };
  const flags = buf[byteOffset];
  const len = buf[byteOffset + 1] << 24 | buf[byteOffset + 2] << 16 | buf[byteOffset + 3] << 8 | buf[byteOffset + 4];
  const msgLen = len < 0 ? len + 4294967296 : len;
  if (msgLen > MAX_FRAME_LEN) return { consumed: -1, frame: null };
  if (byteOffset + 5 + msgLen > buf.length) return { consumed: 0, frame: null };
  const payload = buf.subarray(byteOffset + 5, byteOffset + 5 + msgLen);
  let message = null;
  if (msgLen > 0) {
    try {
      message = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      message = null;
    }
  }
  return { consumed: 5 + msgLen, frame: { flags, message } };
}
function extractDelta(msg) {
  if (!msg) return null;
  const op = String(msg.op ?? "");
  const mask = String(msg.mask ?? "");
  const block = msg.block ?? {};
  if (op === "append") {
    if (mask === "block.text.content") {
      const text = String((block.text ?? {}).content ?? "");
      return text ? { kind: "text", text } : null;
    }
    if (mask === "block.think.content") {
      const text = String((block.think ?? {}).content ?? "");
      return text ? { kind: "think", text } : null;
    }
    return null;
  }
  if (op === "set") {
    if (mask === "block.text") {
      const text = String((block.text ?? {}).content ?? "");
      return text ? { kind: "text", text } : null;
    }
    if (mask === "block.think") {
      const text = String((block.think ?? {}).content ?? "");
      return text ? { kind: "think", text } : null;
    }
  }
  return null;
}
function isEndOfStream(msg) {
  if (!msg) return false;
  const message = msg.message ?? null;
  if (message && String(message.status ?? "") === "MESSAGE_STATUS_COMPLETED" && String(message.role ?? "") === "assistant") {
    return true;
  }
  return false;
}
function foldMessages(messages) {
  let system = "";
  let user = "";
  for (const m of messages) {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    if (m.role === "system") {
      system += (system ? "\n\n" : "") + text;
    } else if (m.role === "user") {
      user = user ? `${user}

${text}` : text;
    } else if (m.role === "assistant") {
      user = user ? `${user}

Assistant: ${text}` : `Assistant: ${text}`;
    }
  }
  return system ? `${system}

${user}` : user;
}
class KimiWebExecutor extends BaseExecutor {
  constructor() {
    super("kimi-web", { id: "kimi-web", baseUrl: BASE_URL });
  }
  buildKimiHeaders(jwt) {
    const headers = {
      "Content-Type": "application/connect+json",
      Accept: "*/*",
      "User-Agent": USER_AGENT,
      Origin: BASE_URL,
      Referer: `${BASE_URL}/`,
      "connect-protocol-version": "1"
    };
    if (jwt) {
      headers["Authorization"] = `Bearer ${jwt}`;
      headers["Cookie"] = `kimi-auth=${jwt}`;
    }
    return headers;
  }
  buildRequestBody(prompt, wantThinking, scenario) {
    return JSON.stringify({
      scenario,
      tools: [{ type: "TOOL_TYPE_SEARCH", search: {} }, { type: "TOOL_TYPE_CRON_JOB" }],
      message: {
        role: "user",
        blocks: [{ message_id: "", text: { content: prompt } }],
        scenario
      },
      options: { thinking: wantThinking, enable_plugin: true }
    });
  }
  async execute(input) {
    const { body, credentials, signal, stream: wantStream } = input;
    const bodyObj = body || {};
    const rawCredential = String(credentials?.apiKey ?? "").trim();
    const jwt = extractKimiJwt(rawCredential);
    if (!jwt) {
      return makeErrorResult(
        400,
        "Missing Kimi session \u2014 paste the full Cookie header from www.kimi.com (must contain kimi-auth=<JWT>) or just the JWT itself.",
        body,
        CHAT_URL
      );
    }
    const messages = bodyObj.messages || [];
    const modelId = bodyObj.model || "kimi-default";
    const modelConfig = resolveModelConfig(modelId);
    const wantThinking = bodyObj.reasoning_effort === "none" ? false : modelConfig.thinking;
    const prompt = foldMessages(messages);
    const reqBody = this.buildRequestBody(prompt, wantThinking, modelConfig.scenario);
    const reqHeaders = this.buildKimiHeaders(jwt);
    const framedBody = frameConnectMessage(reqBody);
    let upstream;
    try {
      upstream = await fetch(CHAT_URL, {
        method: "POST",
        headers: reqHeaders,
        body: new Uint8Array(framedBody),
        signal
      });
    } catch (err) {
      return makeErrorResult(
        502,
        `Kimi fetch failed: ${err instanceof Error ? err.message : "unknown"}`,
        body,
        CHAT_URL
      );
    }
    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      return makeErrorResult(upstream.status, `Kimi error: ${sanitizeErrorMessage(errText)}`, body, CHAT_URL);
    }
    const encoder = new TextEncoder();
    const id = `chatcmpl-kimi-${Date.now()}`;
    const created = Math.floor(Date.now() / 1e3);
    const emitChunk = (controller, delta, finish = null) => {
      const chunk = {
        id,
        object: "chat.completion.chunk",
        created,
        model: modelId,
        choices: [{ index: 0, delta, finish_reason: finish }]
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}

`));
    };
    const sourceStream = upstream.body ?? new ReadableStream({ start: (c) => c.close() });
    if (wantStream) {
      const outStream = new ReadableStream({
        async start(controller) {
          const reader2 = sourceStream.getReader();
          let buffer2 = new Uint8Array(0);
          let emittedRole = false;
          try {
            while (true) {
              const { done, value } = await reader2.read();
              if (done) break;
              if (value) {
                const merged = new Uint8Array(buffer2.length + value.length);
                merged.set(buffer2, 0);
                merged.set(value, buffer2.length);
                buffer2 = merged;
                let offset = 0;
                while (offset < buffer2.length) {
                  const { consumed, frame } = decodeConnectFrame(buffer2, offset);
                  if (consumed === -1) {
                    controller.error(new Error("Kimi Connect frame exceeded MAX_FRAME_LEN"));
                    return;
                  }
                  if (consumed === 0) break;
                  offset += consumed;
                  if (!frame?.message) continue;
                  const delta = extractDelta(frame.message);
                  if (delta) {
                    if (!emittedRole) {
                      emittedRole = true;
                      emitChunk(controller, { role: "assistant", content: "" });
                    }
                    if (delta.kind === "think") {
                      emitChunk(controller, { reasoning_content: delta.text });
                    } else {
                      emitChunk(controller, { content: delta.text });
                    }
                  }
                  if (isEndOfStream(frame.message)) {
                    emitChunk(controller, {}, "stop");
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                    return;
                  }
                }
                buffer2 = buffer2.subarray(offset);
              }
            }
            if (!emittedRole) {
              emitChunk(controller, { role: "assistant", content: "" });
            }
            emitChunk(controller, {}, "stop");
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch (err) {
            if (!signal?.aborted) {
              try {
                controller.error(err);
              } catch {
              }
            }
          }
        }
      });
      return {
        response: new Response(outStream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive"
          }
        }),
        url: CHAT_URL,
        headers: reqHeaders,
        transformedBody: JSON.parse(reqBody)
      };
    }
    let answer = "";
    let reasoning = "";
    const reader = sourceStream.getReader();
    let buffer = new Uint8Array(0);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const merged = new Uint8Array(buffer.length + value.length);
        merged.set(buffer, 0);
        merged.set(value, buffer.length);
        buffer = merged;
        let offset = 0;
        while (offset < buffer.length) {
          const { consumed, frame } = decodeConnectFrame(buffer, offset);
          if (consumed === -1) break;
          if (consumed === 0) break;
          offset += consumed;
          if (!frame?.message) continue;
          const delta = extractDelta(frame.message);
          if (delta) {
            if (delta.kind === "think") reasoning += delta.text;
            else answer += delta.text;
          }
          if (isEndOfStream(frame.message)) {
            offset = buffer.length;
            break;
          }
        }
        buffer = buffer.subarray(offset);
      }
    } catch {
    }
    const message = { role: "assistant", content: answer };
    if (reasoning) message.reasoning_content = reasoning;
    const completion = {
      id,
      object: "chat.completion",
      created,
      model: modelId,
      choices: [{ index: 0, message, finish_reason: "stop" }]
    };
    return {
      response: new Response(JSON.stringify(completion), {
        headers: { "Content-Type": "application/json" }
      }),
      url: CHAT_URL,
      headers: reqHeaders,
      transformedBody: JSON.parse(reqBody)
    };
  }
}
export {
  KimiWebExecutor,
  decodeConnectFrame,
  extractDelta,
  extractKimiJwt,
  foldMessages,
  frameConnectMessage,
  isEndOfStream,
  resolveModelConfig
};
