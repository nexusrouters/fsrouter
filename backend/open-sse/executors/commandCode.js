import { randomUUID } from "node:crypto";
import { isVisionModelId } from "@/shared/constants/visionModels";
import { REGISTRY } from "../config/providerRegistry.ts";
import { BaseExecutor, mergeUpstreamExtraHeaders } from "./base.ts";
const COMMAND_CODE_VERSION = process.env.COMMAND_CODE_VERSION?.trim() || "0.33.2";
const MAX_COMMAND_CODE_TOKENS = 2e5;
const encoder = new TextEncoder();
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asRecordArray(value) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}
function stringValue(value) {
  return typeof value === "string" ? value : void 0;
}
function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function recordOrEmpty(value) {
  if (isRecord(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch (error) {
      console.warn(
        "[commandCode] tool arg parse failed:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  return {};
}
function normalizeContentText(content) {
  if (typeof content === "string") return content;
  return asRecordArray(content).filter((part) => part.type === "text").map((part) => stringValue(part.text) || "").join("\n");
}
const CC_VISION_MODEL_PATTERNS = [
  // Open Source
  /kimi-k2/i,
  // moonshotai/Kimi-K2.6, Kimi-K2.7-Code, Kimi-K2.5
  /qwen3\.\d/i,
  // Qwen/Qwen3.6-Plus, Qwen/Qwen3.7-Plus
  /step-?3/i,
  // stepfun/Step-3.7-Flash
  // Anthropic
  /claude-fable/i,
  // claude-fable-5 (not covered by claude-opus/sonnet/haiku-4)
  // OpenAI
  /gpt-5/i,
  // gpt-5.5, gpt-5.4, gpt-5.3-codex, gpt-5.4-mini
  // Sakana
  /fugu/i
  // sakana/fugu-ultra
];
function isCommandCodeVisionModel(model) {
  if (!model) return false;
  if (/(?:^|\/)mimo-v2\.5-pro$/i.test(model)) return false;
  if (/(?:^|\/)mimo-v2\.5$/i.test(model)) return true;
  if (/(?:^|\/)mimo-v2-omni$/i.test(model)) return true;
  if (CC_VISION_MODEL_PATTERNS.some((pattern) => pattern.test(model))) return true;
  return isVisionModelId(model);
}
function extractImageUrl(part) {
  if (part.type === "image") return stringValue(part.image);
  if (part.type === "image_url") {
    if (isRecord(part.image_url)) return stringValue(part.image_url.url);
    return stringValue(part.image_url);
  }
  return void 0;
}
function convertUserContentParts(content, isVisionModel) {
  if (!isVisionModel || typeof content === "string") {
    return normalizeContentText(content);
  }
  const parts = [];
  for (const part of asRecordArray(content)) {
    if (part.type === "text") {
      const text = stringValue(part.text);
      if (text) parts.push({ type: "text", text });
      continue;
    }
    const imgUrl = extractImageUrl(part);
    if (imgUrl) {
      parts.push({ type: "image", image: imgUrl });
      continue;
    }
  }
  if (parts.length === 0) parts.push({ type: "text", text: "" });
  return parts;
}
function convertTools(tools) {
  return asRecordArray(tools).map((tool) => {
    const fn = isRecord(tool.function) ? tool.function : tool;
    return {
      type: "function",
      name: stringValue(fn.name) || "",
      description: stringValue(fn.description) || "",
      input_schema: isRecord(fn.parameters) ? fn.parameters : {}
    };
  });
}
function completeToolCallIds(messages) {
  const callIds = /* @__PURE__ */ new Set();
  const resultIds = /* @__PURE__ */ new Set();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of asRecordArray(message.tool_calls)) {
        const id = stringValue(call.id);
        if (id) callIds.add(id);
      }
    } else if (message.role === "tool") {
      const id = stringValue(message.tool_call_id);
      if (id) resultIds.add(id);
    }
  }
  return new Set([...callIds].filter((id) => resultIds.has(id)));
}
function convertMessages(messages, model) {
  const source = asRecordArray(messages);
  const pairedToolCallIds = completeToolCallIds(source);
  const out = [];
  const system = [];
  const isVision = isCommandCodeVisionModel(model);
  for (const message of source) {
    const role = stringValue(message.role);
    if (role === "system" || role === "developer") {
      const text = normalizeContentText(message.content);
      if (text) system.push(text);
      continue;
    }
    if (role === "user") {
      out.push({ role: "user", content: convertUserContentParts(message.content, isVision) });
      continue;
    }
    if (role === "assistant") {
      const parts = [];
      const text = normalizeContentText(message.content);
      if (text) parts.push({ type: "text", text });
      for (const call of asRecordArray(message.tool_calls)) {
        const id = stringValue(call.id) || "";
        if (!id || !pairedToolCallIds.has(id)) continue;
        const fn = isRecord(call.function) ? call.function : {};
        parts.push({
          type: "tool-call",
          toolCallId: id,
          toolName: stringValue(fn.name) || "",
          input: recordOrEmpty(fn.arguments)
        });
      }
      if (parts.length > 0) out.push({ role: "assistant", content: parts });
      continue;
    }
    if (role === "tool") {
      const toolCallId = stringValue(message.tool_call_id) || "";
      if (!toolCallId || !pairedToolCallIds.has(toolCallId)) continue;
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName: stringValue(message.name) || "",
            output: { type: "text", value: normalizeContentText(message.content) }
          }
        ]
      });
    }
  }
  return { system: system.join("\n\n"), messages: out };
}
function clampMaxTokens(value) {
  const numeric = numberValue(value);
  if (numeric === void 0 || numeric <= 0) return void 0;
  return Math.min(Math.floor(numeric), MAX_COMMAND_CODE_TOKENS);
}
const COMMAND_CODE_PASSTHROUGH_FIELDS = [
  "reasoning_effort",
  "reasoning",
  "thinking",
  "effort",
  "output_config",
  "extra_body"
];
function buildCommandCodeBody(model, body, stream = false) {
  const input = isRecord(body) ? body : {};
  const resolvedModel = typeof input.model === "string" && input.model.trim().length > 0 ? input.model : model;
  const converted = convertMessages(input.messages, resolvedModel);
  const explicitSystem = typeof input.system === "string" ? input.system : "";
  const system = [converted.system, explicitSystem].filter(Boolean).join("\n\n");
  const params = {
    model: resolvedModel,
    messages: converted.messages,
    tools: convertTools(input.tools),
    system,
    stream: true
  };
  const maxTokens = clampMaxTokens(input.max_tokens ?? input.max_completion_tokens);
  if (maxTokens !== void 0) {
    params.max_tokens = maxTokens;
  }
  for (const field of COMMAND_CODE_PASSTHROUGH_FIELDS) {
    const value = input[field];
    if (value !== void 0 && value !== null) {
      params[field] = value;
    }
  }
  return {
    config: {
      workingDir: "/workspace",
      date: (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
      environment: "external",
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: []
    },
    memory: "",
    taste: "",
    skills: "",
    permissionMode: "standard",
    params
  };
}
function parseStreamLine(line) {
  let trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":") || trimmed.startsWith("event:")) return void 0;
  if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim();
  if (!trimmed || trimmed === "[DONE]") return void 0;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    console.warn(
      "[commandCode] stream line parse failed:",
      error instanceof Error ? error.message : String(error)
    );
    return void 0;
  }
}
function mapFinishReason(reason) {
  if (reason === "tool-calls" || reason === "tool_calls" || reason === "toolUse")
    return "tool_calls";
  if (reason === "length" || reason === "max_tokens" || reason === "max-tokens" || reason === "max_output_tokens") {
    return "length";
  }
  return "stop";
}
function chatCompletionChunk(id, model, delta, finishReason = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1e3),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  };
}
function sse(data) {
  return encoder.encode(`data: ${JSON.stringify(data)}

`);
}
function applyEventToAggregate(event, state) {
  switch (event.type) {
    case "text-delta":
      state.content += stringValue(event.text) || "";
      break;
    case "reasoning-delta":
      state.reasoning += stringValue(event.text) || "";
      break;
    case "tool-call": {
      const args = recordOrEmpty(event.input ?? event.args ?? event.arguments);
      state.toolCalls.push({
        id: stringValue(event.toolCallId) || stringValue(event.id) || randomUUID(),
        type: "function",
        function: {
          name: stringValue(event.toolName) || stringValue(event.name) || "",
          arguments: JSON.stringify(args)
        }
      });
      break;
    }
    case "finish":
      state.finishReason = mapFinishReason(event.finishReason);
      state.usage = isRecord(event.totalUsage) ? event.totalUsage : null;
      break;
  }
}
function applyEventToAggregateOrThrow(event, state) {
  if (event.type === "error") {
    const error = isRecord(event.error) ? event.error : {};
    throw new Error(
      stringValue(error.message) || stringValue(event.error) || "Command Code stream error"
    );
  }
  applyEventToAggregate(event, state);
}
function usageFromCommandCode(usage) {
  if (!usage) return void 0;
  const details = isRecord(usage.inputTokenDetails) ? usage.inputTokenDetails : {};
  const prompt = (numberValue(usage.inputTokens) || 0) + (numberValue(details.cacheReadTokens) || 0);
  const completion = numberValue(usage.outputTokens) || 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion
  };
}
function createStreamResponse(upstream, model, signal) {
  const id = `chatcmpl-${randomUUID()}`;
  const reader = upstream.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sentRole = false;
  let closed = false;
  const state = {
    content: "",
    reasoning: "",
    toolCalls: [],
    finishReason: "stop",
    usage: null
  };
  const stream = new ReadableStream({
    start(controller) {
      if (!reader) {
        controller.error(new Error("Command Code response missing body"));
        return;
      }
      const abort = () => {
        closed = true;
        reader.cancel().catch(() => void 0);
        controller.error(new DOMException("The operation was aborted", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      const emitEvent = (event) => {
        if (!isRecord(event) || closed) return;
        if (!sentRole) {
          sentRole = true;
          controller.enqueue(sse(chatCompletionChunk(id, model, { role: "assistant" })));
        }
        switch (event.type) {
          case "text-delta": {
            const text = stringValue(event.text) || "";
            if (text) controller.enqueue(sse(chatCompletionChunk(id, model, { content: text })));
            state.content += text;
            break;
          }
          case "reasoning-delta": {
            const text = stringValue(event.text) || "";
            if (text) {
              controller.enqueue(sse(chatCompletionChunk(id, model, { reasoning_content: text })));
              state.reasoning += text;
            }
            break;
          }
          case "tool-call": {
            const index = state.toolCalls.length;
            const args = recordOrEmpty(event.input ?? event.args ?? event.arguments);
            const toolCall = {
              id: stringValue(event.toolCallId) || stringValue(event.id) || randomUUID(),
              type: "function",
              function: {
                name: stringValue(event.toolName) || stringValue(event.name) || "",
                arguments: JSON.stringify(args)
              }
            };
            state.toolCalls.push(toolCall);
            controller.enqueue(
              sse(chatCompletionChunk(id, model, { tool_calls: [{ index, ...toolCall }] }))
            );
            break;
          }
          case "reasoning-end":
            break;
          case "finish": {
            state.finishReason = mapFinishReason(event.finishReason);
            state.usage = isRecord(event.totalUsage) ? event.totalUsage : null;
            controller.enqueue(sse(chatCompletionChunk(id, model, {}, state.finishReason)));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            closed = true;
            controller.close();
            reader.cancel().catch(() => void 0);
            break;
          }
          case "error": {
            const error = isRecord(event.error) ? event.error : {};
            throw new Error(
              stringValue(error.message) || stringValue(event.error) || "Command Code stream error"
            );
          }
        }
      };
      const pump = async () => {
        try {
          for (; ; ) {
            if (closed) return;
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) emitEvent(parseStreamLine(line));
          }
          if (buffer.trim()) emitEvent(parseStreamLine(buffer));
          if (!closed) {
            if (!sentRole)
              controller.enqueue(sse(chatCompletionChunk(id, model, { role: "assistant" })));
            controller.enqueue(sse(chatCompletionChunk(id, model, {}, state.finishReason)));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }
        } catch (error) {
          controller.error(error);
        } finally {
          signal?.removeEventListener("abort", abort);
          try {
            reader.releaseLock();
          } catch (error) {
            console.warn(
              "[commandCode] reader releaseLock failed:",
              error instanceof Error ? error.message : String(error)
            );
          }
        }
      };
      pump();
    },
    cancel() {
      closed = true;
      return reader?.cancel();
    }
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" }
  });
}
async function createJsonResponse(upstream, model, signal) {
  const reader = upstream.body?.getReader();
  if (!reader) throw new Error("Command Code response missing body");
  const decoder = new TextDecoder();
  let buffer = "";
  const state = {
    content: "",
    reasoning: "",
    toolCalls: [],
    finishReason: "stop",
    usage: null
  };
  try {
    for (; ; ) {
      if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const event = parseStreamLine(line);
        if (!isRecord(event)) continue;
        applyEventToAggregateOrThrow(event, state);
      }
    }
    if (buffer.trim()) {
      const event = parseStreamLine(buffer);
      if (isRecord(event)) applyEventToAggregateOrThrow(event, state);
    }
  } finally {
    try {
      await reader.cancel();
    } catch (error) {
      console.warn(
        "[commandCode] reader cancel failed:",
        error instanceof Error ? error.message : String(error)
      );
    }
    try {
      reader.releaseLock();
    } catch (error) {
      console.warn(
        "[commandCode] reader releaseLock failed:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  const message = { role: "assistant", content: state.content };
  if (state.reasoning) message.reasoning_content = state.reasoning;
  if (state.toolCalls.length > 0) message.tool_calls = state.toolCalls;
  const payload = {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1e3),
    model,
    choices: [{ index: 0, message, finish_reason: state.finishReason }]
  };
  const usage = usageFromCommandCode(state.usage);
  if (usage) payload.usage = usage;
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
class CommandCodeExecutor extends BaseExecutor {
  constructor(provider = "command-code") {
    super(provider, REGISTRY["command-code"]);
  }
  buildUrl() {
    const baseUrl = (this.config.baseUrl || "https://api.commandcode.ai").replace(/\/$/, "");
    return `${baseUrl}${this.config.chatPath || "/alpha/generate"}`;
  }
  async execute({ model, body, stream, credentials, signal, upstreamExtraHeaders }) {
    const apiKey = credentials?.apiKey || credentials?.accessToken;
    if (!apiKey) throw new Error("Command Code API key required");
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "x-command-code-version": COMMAND_CODE_VERSION,
      "x-cli-environment": "external",
      "x-project-slug": "pi-cc",
      "x-taste-learning": "false",
      "x-co-flag": "false",
      "x-session-id": randomUUID()
    };
    mergeUpstreamExtraHeaders(headers, upstreamExtraHeaders);
    const transformedBody = buildCommandCodeBody(model, body, stream);
    const url = this.buildUrl();
    const upstream = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(transformedBody),
      signal: signal || void 0
    });
    if (!upstream.ok) {
      const errorText = await upstream.text().catch(() => {
        console.warn("[commandCode] upstream text failed");
        return "";
      });
      return {
        response: new Response(errorText || `Command Code API error ${upstream.status}`, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: upstream.headers
        }),
        url,
        headers,
        transformedBody
      };
    }
    const response = stream ? createStreamResponse(upstream, model, signal) : await createJsonResponse(upstream, model, signal);
    return { response, url, headers, transformedBody };
  }
}
export {
  COMMAND_CODE_VERSION,
  CommandCodeExecutor
};
