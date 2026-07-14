import { sanitizeErrorMessage } from "./error.ts";
const REASON_MESSAGES = {
  empty: "no content produced",
  stall: "stream stalled (no data within the stall window)",
  abort: "stream aborted",
  client_closed: "client closed the connection",
  no_terminal: "stream closed without a terminal event",
  parse_fail: "failed to parse upstream stream",
  empty_choices: "response had no usable choices/output",
  empty_stream: "upstream stream carried no content"
};
function describeReason(reason) {
  if (!reason) return "empty response";
  return REASON_MESSAGES[reason] ?? reason;
}
function reportMalformed200(opts) {
  const {
    mode,
    provider,
    model,
    connectionId,
    reason,
    recvBytes,
    recvLines,
    emitted,
    events,
    ttftMs,
    elapsedMs
  } = opts;
  const evtStr = events && typeof events === "object" ? `[${Object.entries(events).map(([k, v]) => `${k}=${v}`).join(",")}]` : "[]";
  console.log(
    `[MALFORMED-200] mode=${mode || "?"} provider=${provider || "?"} model=${model || "?"} conn=${connectionId || "-"} reason=${reason || "empty"} recvBytes=${recvBytes ?? -1} recvLines=${recvLines ?? -1} emitted=${emitted ?? -1} events=${evtStr} ttft=${ttftMs ?? -1}ms dur=${elapsedMs ?? -1}ms`
  );
}
function synthOpenAIErrorChunk(opts) {
  const { provider, model, reason } = opts;
  const reasonText = sanitizeErrorMessage(describeReason(reason));
  const providerPart = sanitizeErrorMessage(provider ?? "?");
  const safeMessage = sanitizeErrorMessage(
    `[${providerPart}] returned an empty response (${reasonText}). Likely quota exhaustion, an overloaded upstream, or a proxy/gateway intercepting the stream.`
  );
  const body = {
    id: `chatcmpl-empty-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1e3),
    model: sanitizeErrorMessage(model ?? "unknown"),
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    error: {
      message: safeMessage,
      type: "upstream_empty_response"
    }
  };
  return `data: ${JSON.stringify(body)}

`;
}
function synthResponsesFailure(reason) {
  const safeMessage = sanitizeErrorMessage(
    `stream closed before response.completed (${describeReason(reason)})`
  );
  const event = {
    type: "response.failed",
    response: {
      id: null,
      status: "failed",
      error: {
        type: "stream_error",
        code: "stream_disconnected",
        message: safeMessage
      }
    }
  };
  return `event: response.failed
data: ${JSON.stringify(event)}

`;
}
function detectMalformedNonStream(resp) {
  if (!resp || typeof resp !== "object") return "empty_choices";
  const body = resp;
  if (body.object === "response") {
    const output = body.output;
    const hasOutput = Array.isArray(output) && output.some((item) => {
      if (!item || typeof item !== "object") return false;
      const it = item;
      if (it.type === "message") {
        return Array.isArray(it.content) && it.content.some((c) => {
          const part = c;
          return typeof part?.text === "string" && part.text.length > 0;
        });
      }
      return Boolean(it.type);
    });
    if (!hasOutput) return "empty_choices";
    const status = typeof body.status === "string" ? body.status : "";
    if (status && !["completed", "done"].includes(status)) return "no_terminal";
    return null;
  }
  if (body.type === "message" && Array.isArray(body.content)) {
    const hasOutput = body.content.some((block) => {
      if (block === null || typeof block !== "object") return false;
      const b = block;
      if (b.type === "text" && typeof b.text === "string" && b.text.length > 0 && b.text !== "(empty response)") {
        return true;
      }
      if (b.type === "thinking" && (typeof b.thinking === "string" && b.thinking.length > 0 || typeof b.signature === "string" && b.signature.length > 0)) {
        return true;
      }
      if (b.type === "redacted_thinking") return true;
      if (b.type === "tool_use" && typeof b.id === "string" && b.id.length > 0) {
        return true;
      }
      return false;
    });
    return hasOutput ? null : "empty_choices";
  }
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) return "empty_choices";
  const anyHasOutput = choices.some((choice) => {
    const c = choice;
    const msg = c?.message;
    if (typeof msg?.content === "string" && msg.content.length > 0) return true;
    if (Array.isArray(msg?.content) && msg.content.some((block) => {
      const b = block;
      return !!b && typeof b === "object" && b.type === "text" && typeof b.text === "string" && b.text.length > 0;
    }))
      return true;
    if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) return true;
    if (typeof msg?.reasoning_content === "string" && msg.reasoning_content.length > 0)
      return true;
    return false;
  });
  if (!anyHasOutput) return "empty_choices";
  return null;
}
const __test = { describeReason };
export {
  __test,
  detectMalformedNonStream,
  reportMalformed200,
  synthOpenAIErrorChunk,
  synthResponsesFailure
};
