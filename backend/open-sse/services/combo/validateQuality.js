import {
  createSSEDataLineNormalizer,
  isKnownNonClaudeStreamPayload
} from "../../utils/streamHelpers.ts";
import { evaluateResponseValidation } from "./responseValidation.ts";
import { getReasoningTokens } from "../../../src/lib/usage/tokenAccounting.ts";
function toRetryAfterDisplayValue(value) {
  if (typeof value !== "number") return value;
  if (value > 0 && value < 1e9) {
    return new Date(Date.now() + value * 1e3);
  }
  return new Date(value);
}
function responsesApiOutputHasContent(output) {
  return Array.isArray(output) && output.some((item) => {
    if (!item || typeof item !== "object") return false;
    const record = item;
    if (record.type !== "message") return Boolean(record.type);
    const content = record.content;
    return Array.isArray(content) && content.some(
      (part) => !!part && typeof part === "object" && typeof part.text === "string" && part.text.length > 0
    );
  });
}
async function validateResponseQuality(response, isStreaming, log, responseValidation) {
  if (isStreaming) {
    let parseAccumulatedSse = function() {
      const lines = decodedSoFar.split(/\r?\n/);
      decodedSoFar = lines[lines.length - 1];
      for (const line of sseLineNormalizer.normalize(lines.slice(0, -1))) {
        const trimmed = line.trim();
        if (trimmed.startsWith("event:")) {
          pendingEventType = trimmed.slice(6).trim();
          continue;
        }
        if (!trimmed.startsWith("data:")) {
          if (!trimmed) pendingEventType = "";
          continue;
        }
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        const eventType = (typeof parsed.type === "string" ? parsed.type : null) || pendingEventType || "";
        pendingEventType = "";
        if (isKnownNonClaudeStreamPayload(parsed, eventType)) {
          return true;
        }
        switch (eventType) {
          case "message_start":
            hasMessageStart = true;
            break;
          case "content_block_start":
          case "content_block_delta":
          case "content_block_stop":
            hasContentBlock = true;
            return true;
          case "message_stop":
            hasLifecycleEnd = true;
            break;
          case "message_delta": {
            const delta = parsed.delta;
            if (delta && typeof delta === "object" && delta.stop_reason != null) {
              hasLifecycleEnd = true;
            }
            break;
          }
          default:
            break;
        }
      }
      return false;
    }, buildReplayResponse = function(readerToForward) {
      const prefix = bufferedChunks.slice();
      let prefixIdx = 0;
      const stream = new ReadableStream({
        async pull(controller) {
          if (prefixIdx < prefix.length) {
            controller.enqueue(prefix[prefixIdx++]);
            return;
          }
          try {
            const { done, value } = await readerToForward.read();
            if (done) {
              controller.close();
            } else {
              controller.enqueue(value);
            }
          } catch {
            controller.close();
          }
        }
      });
      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    };
    const contentType2 = response.headers.get("content-type") || "";
    if (!contentType2.includes("text/event-stream")) {
      return { valid: true };
    }
    if (!response.body) {
      return { valid: true };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    const bufferedChunks = [];
    let decodedSoFar = "";
    let hasMessageStart = false;
    let hasContentBlock = false;
    let hasLifecycleEnd = false;
    let anyContentFound = false;
    let sawAnyBytes = false;
    const sseLineNormalizer = createSSEDataLineNormalizer();
    let pendingEventType = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          const tail = decoder.decode(void 0, { stream: false });
          if (tail) decodedSoFar += tail;
          if (decodedSoFar.trim()) decodedSoFar += "\n\n";
          parseAccumulatedSse();
          if (hasMessageStart && hasLifecycleEnd && !hasContentBlock) {
            log.warn?.(
              "COMBO",
              "Streaming Claude response has complete lifecycle but zero content blocks (content_filter?) \u2014 marking as invalid for combo failover"
            );
            return { valid: false, reason: "streaming empty content block" };
          }
          if (!anyContentFound && !hasContentBlock && !sawAnyBytes) {
            log.warn?.(
              "COMBO",
              "Streaming response ended with no recognized content \u2014 marking as invalid for combo failover"
            );
            return { valid: false, reason: "streaming no recognized content" };
          }
          const clonedResponse = buildReplayResponse(reader);
          return { valid: true, clonedResponse };
        }
        bufferedChunks.push(value);
        if (value && value.length > 0) sawAnyBytes = true;
        decodedSoFar += decoder.decode(value, { stream: true });
        const foundContent = parseAccumulatedSse();
        if (foundContent) {
          anyContentFound = true;
          const clonedResponse = buildReplayResponse(reader);
          return { valid: true, clonedResponse };
        }
      }
    } catch (streamErr) {
      const errMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);
      if (streamErr instanceof TypeError && (errMsg.includes("locked") || errMsg.includes("disturbed") || errMsg.includes("used already"))) {
        return { valid: false, reason: "stream locked or disturbed" };
      }
      return { valid: true };
    }
  }
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json") && !contentType.includes("text/")) {
    return { valid: true };
  }
  let cloned;
  try {
    cloned = response.clone();
  } catch {
    return { valid: true };
  }
  let text;
  try {
    text = await cloned.text();
  } catch {
    return { valid: true };
  }
  if (!text || text.trim().length === 0) {
    return { valid: false, reason: "empty response body" };
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    if (text.startsWith("data:") || text.startsWith("event:")) return { valid: true };
    return { valid: false, reason: "response is not valid JSON" };
  }
  if (responseValidation) {
    const verdict = evaluateResponseValidation(json, responseValidation);
    if (!verdict.valid) {
      return { valid: false, reason: verdict.reason };
    }
  }
  const choices = json?.choices;
  if (json?.object === "response") {
    if (!responsesApiOutputHasContent(json.output))
      return { valid: false, reason: "empty_choices" };
    const status = typeof json.status === "string" ? json.status : "";
    if (status && !["completed", "done"].includes(status)) {
      return { valid: false, reason: "no_terminal" };
    }
    return {
      valid: true,
      clonedResponse: new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      })
    };
  }
  if (!Array.isArray(choices) || choices.length === 0) {
    if (json?.output || json?.result || json?.data || json?.response) return { valid: true };
    if (json?.error) {
      const err = json.error;
      return {
        valid: false,
        reason: `upstream error in 200 body: ${err?.message || JSON.stringify(json.error).substring(0, 200)}`
      };
    }
    return { valid: true };
  }
  const firstChoice = choices[0];
  const message = firstChoice?.message || firstChoice?.delta;
  if (!message) {
    return { valid: false, reason: "choice has no message object" };
  }
  const content = message.content;
  const toolCalls = message.tool_calls;
  const reasoningContent = message.reasoning_content ?? message.reasoning;
  const hasReasoningContent = typeof reasoningContent === "string" && reasoningContent.trim().length > 0;
  const hasContent = content !== null && content !== void 0 && content !== "" || hasReasoningContent;
  const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
  if (!hasContent && !hasToolCalls) {
    return { valid: false, reason: "empty content and no tool_calls in response" };
  }
  const contentIsEmpty = content === null || content === void 0 || content === "";
  if (contentIsEmpty && hasReasoningContent && !hasToolCalls) {
    const usage = json?.usage;
    if (usage) {
      const completionTokens = Number(usage.completion_tokens) || 0;
      const reasoningTokens = getReasoningTokens(usage);
      if (completionTokens > 0 && reasoningTokens >= completionTokens * 0.9) {
        return {
          valid: false,
          reason: `reasoning consumed ${reasoningTokens}/${completionTokens} tokens \u2014 no content output`
        };
      }
    }
  }
  return {
    valid: true,
    clonedResponse: new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    })
  };
}
function releaseQualityClone(clone, original, quality) {
  if (clone === original) return;
  void quality.clonedResponse?.body?.cancel().catch(() => {
  });
}
export {
  releaseQualityClone,
  toRetryAfterDisplayValue,
  validateResponseQuality
};
