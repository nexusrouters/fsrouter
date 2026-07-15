import WebSocket from "ws";
import { FETCH_TIMEOUT_MS } from "../config/constants.ts";
import { sanitizeErrorMessage } from "../utils/error.js";
import { BaseExecutor } from "./base.ts";
import {
  buildPrompt,
  buildWsUrl,
  redactWsUrl,
  resolveConnectionParams
} from "./copilot-m365-connection.ts";
import {
  accumulateBotContent,
  buildChatInvocation,
  encodeFrame,
  extractFinalResultMessage,
  handshakeError,
  handshakeFrame,
  isCompletionFrame,
  keepaliveFrame,
  parseFrame,
  splitFrames
} from "./copilot-m365-frames.ts";
let WebSocketCtor = WebSocket;
function __setCopilotM365WebSocketForTesting(ctor) {
  const previous = WebSocketCtor;
  WebSocketCtor = ctor;
  return () => {
    WebSocketCtor = previous;
  };
}
function sseChunk(model, delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id: `chatcmpl-copilot-m365-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1e3),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  })}

`;
}
function errorResponse(message, status = 502) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
class CopilotM365WebExecutor extends BaseExecutor {
  constructor() {
    super("copilot-m365-web", { id: "copilot-m365-web", baseUrl: "wss://substrate.office.com" });
  }
  async wsChat(input) {
    const log = input.log ?? null;
    return new ReadableStream(
      {
        start: async (controller) => {
          const encoder = new TextEncoder();
          let ws = null;
          let settled = false;
          let buffer = "";
          let previousText = "";
          let finalResultMessage = "";
          let handshakeComplete = false;
          const cleanup = () => {
            if (ws) {
              try {
                ws.close();
              } catch {
              }
              ws = null;
            }
          };
          const finish = () => {
            if (settled) return;
            settled = true;
            cleanup();
            if (!previousText && finalResultMessage) {
              controller.enqueue(
                encoder.encode(sseChunk(input.model, { content: finalResultMessage }))
              );
            }
            controller.enqueue(encoder.encode(sseChunk(input.model, {}, "stop")));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          };
          const abort = (reason) => {
            if (settled) return;
            settled = true;
            cleanup();
            const message = sanitizeErrorMessage(reason);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message } })}

`));
            controller.close();
          };
          input.signal?.addEventListener("abort", () => abort("Request aborted"), { once: true });
          const timeout = setTimeout(
            () => abort("Microsoft 365 Copilot WebSocket timeout"),
            FETCH_TIMEOUT_MS
          );
          try {
            const wsUrlParts = new URL(input.wsUrl);
            const traceId = wsUrlParts.searchParams.get("clientrequestid") ?? crypto.randomUUID().replace(/-/g, "");
            const sessionId = wsUrlParts.searchParams.get("X-SessionId") ?? crypto.randomUUID();
            log?.debug?.("M365_WS", `connecting \u2192 ${redactWsUrl(input.wsUrl)}`);
            ws = new WebSocketCtor(input.wsUrl, {
              headers: {
                Origin: "https://m365.cloud.microsoft",
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
              }
            });
            const sendChat = () => {
              ws?.send(keepaliveFrame());
              ws?.send(
                encodeFrame(
                  buildChatInvocation({
                    text: input.prompt,
                    traceId,
                    sessionId,
                    isStartOfSession: true
                  })
                )
              );
            };
            ws.on("open", () => {
              log?.debug?.("M365_WS", "socket open \u2014 sending handshake");
              ws?.send(handshakeFrame());
            });
            ws.on("message", (data) => {
              if (settled) return;
              buffer += data.toString();
              const split = splitFrames(buffer);
              buffer = split.rest;
              for (const rawFrame of split.frames) {
                const frame = parseFrame(rawFrame);
                log?.debug?.(
                  "M365_WS",
                  `frame type=${String(frame?.type)} target=${String(frame?.target)}`
                );
                if (!handshakeComplete) {
                  const err = handshakeError(frame);
                  if (err) {
                    clearTimeout(timeout);
                    log?.debug?.("M365_WS", `handshake failed: ${err}`);
                    abort(`Microsoft 365 Copilot handshake failed: ${err}`);
                    return;
                  }
                  handshakeComplete = true;
                  log?.debug?.("M365_WS", "handshake complete \u2014 sending chat invocation");
                  sendChat();
                  continue;
                }
                const { delta, next } = accumulateBotContent(previousText, frame);
                previousText = next;
                if (delta) {
                  controller.enqueue(encoder.encode(sseChunk(input.model, { content: delta })));
                }
                const finalMsg = extractFinalResultMessage(frame);
                if (finalMsg) {
                  finalResultMessage = finalMsg;
                }
                if (isCompletionFrame(frame)) {
                  clearTimeout(timeout);
                  finish();
                  return;
                }
              }
            });
            ws.on("error", (err) => {
              clearTimeout(timeout);
              log?.debug?.(
                "M365_WS",
                `socket error: ${err instanceof Error ? err.message : String(err)}`
              );
              abort(
                sanitizeErrorMessage(
                  err instanceof Error ? err.message : "Microsoft 365 Copilot WebSocket error"
                )
              );
            });
            ws.on("close", () => {
              clearTimeout(timeout);
              finish();
            });
          } catch (err) {
            clearTimeout(timeout);
            abort(
              sanitizeErrorMessage(
                err instanceof Error ? err.message : "Failed to connect to Microsoft 365 Copilot"
              )
            );
          }
        }
      },
      { highWaterMark: 16384 }
    );
  }
  async execute(input) {
    const body = input.body;
    const model = input.model || body?.model || "copilot-m365";
    const stream = input.stream !== false;
    const prompt = buildPrompt(body).trim();
    if (!prompt) {
      return {
        response: errorResponse("No user message provided", 400),
        url: "wss://substrate.office.com/m365Copilot/Chathub",
        headers: {},
        transformedBody: null
      };
    }
    const connectionParams = resolveConnectionParams(input.credentials);
    if ("error" in connectionParams) {
      return {
        response: errorResponse(connectionParams.error, 400),
        url: "wss://substrate.office.com/m365Copilot/Chathub",
        headers: {},
        transformedBody: { model, prompt: prompt.slice(0, 100) }
      };
    }
    const wsUrl = buildWsUrl(connectionParams);
    try {
      const wsStream = await this.wsChat({
        wsUrl,
        prompt,
        model,
        signal: input.signal ?? void 0,
        log: input.log
      });
      if (stream) {
        return {
          response: new Response(wsStream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive"
            }
          }),
          url: redactWsUrl(wsUrl),
          headers: {},
          transformedBody: { model, prompt: prompt.slice(0, 100) }
        };
      }
      const reader = wsStream.getReader();
      const decoder = new TextDecoder();
      let fullText = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value, { stream: true }).split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (typeof content === "string") fullText += content;
          } catch {
          }
        }
      }
      return {
        response: new Response(
          JSON.stringify({
            id: `chatcmpl-copilot-m365-${Date.now()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1e3),
            model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: fullText || "(empty response)" },
                finish_reason: "stop"
              }
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
          }),
          { headers: { "Content-Type": "application/json" } }
        ),
        url: redactWsUrl(wsUrl),
        headers: {},
        transformedBody: { model, prompt: prompt.slice(0, 100) }
      };
    } catch (err) {
      const message = sanitizeErrorMessage(
        err instanceof Error ? err.message : "Microsoft 365 Copilot executor error"
      );
      return {
        response: errorResponse(message),
        url: redactWsUrl(wsUrl),
        headers: {},
        transformedBody: { model, prompt: prompt.slice(0, 100) }
      };
    }
  }
}
export {
  CopilotM365WebExecutor,
  __setCopilotM365WebSocketForTesting
};
