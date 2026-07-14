// ─── Codex Executor (AMRouter) ─────────────────────────────────────────────
// Converted from OmniRoute TypeScript to plain JavaScript for AMRouter.
// Inlines: codex/quota.ts, codex/tools.ts sub-modules.
// Preserves all key business logic from OmniRoute codex.ts (1270 lines).

import { createRequire } from "module";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { CODEX_DEFAULT_INSTRUCTIONS } from "../config/codexInstructions.js";
import { normalizeResponsesInput } from "../translator/formats/responsesApi.js";
import { fetchImageAsBase64 } from "../translator/concerns/image.js";
import { getModelUpstreamId } from "../config/providerModels.js";
import { DEFAULT_RETRY_CONFIG, HTTP_STATUS, resolveRetryEntry } from "../config/runtimeConfig.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import {
  refreshProviderCredentials,
  shouldRefreshCredentials,
} from "../services/oauthCredentialManager.js";
import { getAccessToken } from "../services/tokenRefresh.js";
import { dbg } from "../utils/debugLog.js";

// ─── Inline stubs for OmniRoute-only modules ─────────────────────────────

// OmniRoute codexInstructions.ts also exports CODEX_CHAT_DEFAULT_INSTRUCTIONS
const CODEX_CHAT_DEFAULT_INSTRUCTIONS =
  "You are a helpful assistant. Follow the developer instructions in the conversation.";

// OmniRoute config/codexClient.ts
function getCodexClientVersion() { return "0.200.0"; }
function getCodexUserAgent() { return "codex-cli/0.200.0 (node)"; }
function normalizeCodexSessionId(v) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t.slice(0, 256) : null;
}

// OmniRoute config/codexIdentity.ts — client identity for Codex backend
function createCodexClientIdentity(sessionId, providerSpecificData) {
  // Return a minimal identity object; real OmniRoute reads from config/DB
  if (!sessionId) return null;
  return { sessionId, clientId: "amrouter" };
}
function applyCodexClientIdentityHeaders(headers, identity) {
  if (!identity) return;
  // Codex backend expects these headers for identity tracking
  if (identity.sessionId) headers["session_id"] = identity.sessionId;
}
function applyCodexClientMetadata(body, identity) {
  if (!identity) return;
  // Codex client_metadata is used for telemetry
  if (!body.client_metadata) body.client_metadata = {};
  body.client_metadata.client_id = identity.clientId || "amrouter";
}

// OmniRoute lib/providers/requestDefaults.ts
function getCodexRequestDefaults(providerSpecificData) {
  return {
    serviceTier: providerSpecificData?.serviceTier || null,
    reasoningEffort: providerSpecificData?.reasoningEffort || null,
  };
}

// OmniRoute config/codexQuotaScopes.ts — scope-aware rate limiting
function getCodexModelScope(model) {
  if (typeof model !== "string") return "codex";
  const lower = model.toLowerCase();
  if (lower.includes("spark") || lower.includes("mini")) return "spark";
  return "codex";
}
function getCodexRateLimitKey(model, connectionId) {
  const scope = getCodexModelScope(model);
  return `${scope}:${connectionId || "default"}`;
}

// OmniRoute services/responsesInputSanitizer.ts
function sanitizeResponsesInputItems(input, _strict, options) {
  if (!Array.isArray(input)) return input;
  const dropInternal = options?.dropInternalAssistantMessages;
  return input.filter((item) => {
    if (!item || typeof item !== "object") return true;
    // Drop internal assistant messages that aren't meant for upstream
    if (dropInternal && item.role === "assistant" && item._internal) return false;
    return true;
  });
}

// OmniRoute services/codexVerbosity.ts
function normalizeCodexVerbosity(body) {
  // Fold Chat-style `verbosity` / Responses `text.verbosity` into text:{verbosity}
  const verbosity = body.verbosity;
  if (verbosity !== undefined) {
    delete body.verbosity;
    if (typeof verbosity === "string" && verbosity.trim()) {
      body.text = { ...(body.text && typeof body.text === "object" ? body.text : {}), verbosity: verbosity.trim().toLowerCase() };
    }
  }
  // Ensure text.verbosity is a valid value
  if (body.text && typeof body.text === "object" && body.text.verbosity) {
    const v = String(body.text.verbosity).toLowerCase();
    const VALID = new Set(["low", "medium", "high"]);
    if (!VALID.has(v)) delete body.text.verbosity;
  }
}

// OmniRoute services/thinkingBudget.ts
const ThinkingMode = { PASSTHROUGH: "passthrough", DEFAULT: "default" };
function getThinkingBudgetConfig() {
  const mode = process.env.CODEX_THINKING_MODE || ThinkingMode.DEFAULT;
  return { mode };
}

// OmniRoute utils/cors.ts
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// OmniRoute utils/responsesInputNormalization.ts
function normalizeCodexResponsesInput(body) {
  // Handle messages/prompt → input conversion (Cursor, other clients)
  if (!body.input && Array.isArray(body.messages)) {
    body.input = body.messages.map((msg) => ({
      type: "message",
      role: typeof msg.role === "string" ? msg.role : "user",
      ...(typeof msg.phase === "string" ? { phase: msg.phase } : {}),
      content:
        typeof msg.content === "string"
          ? [{ type: "input_text", text: msg.content }]
          : Array.isArray(msg.content)
            ? msg.content.map((cp) => {
                if (cp && typeof cp === "object" && !Array.isArray(cp) && cp.type === "text") {
                  return { type: "input_text", text: cp.text };
                }
                return cp;
              })
            : [],
    }));
  } else if (!body.input && typeof body.prompt === "string" && body.prompt.trim()) {
    body.input = [
      { type: "message", role: "user", content: [{ type: "input_text", text: body.prompt }] },
    ];
  } else if (!body.input && Array.isArray(body.prompt)) {
    body.input = body.prompt.map((p) => ({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: typeof p === "string" ? p : JSON.stringify(p) }],
    }));
  }
}

// OmniRoute utils/providerRequestLogging.ts — stub
const prl = {
  async captureCurrentProviderBody(_url, _headers, _body, _log) { /* noop */ },
};

// ─── Constants ──────────────────────────────────────────────────────────────

const EFFORT_ORDER = ["none", "low", "medium", "high", "xhigh"];
const CODEX_FAST_WIRE_VALUE = "priority";
const CODEX_RESPONSES_WS_URL = "wss://chatgpt.com/backend-api/codex/responses";
const CODEX_REASONING_ENCRYPTED_CONTENT_INCLUDE = "reasoning.encrypted_content";
const CODEX_DEFAULT_REASONING_SUMMARY = "auto";

const MAX_EFFORT_BY_MODEL = {
  "gpt-5.3-codex": "xhigh",
  "gpt-5.1-codex-max": "xhigh",
  "gpt-5-mini": "high",
  "gpt-5.1-mini": "high",
  "gpt-4.1-mini": "high",
};

const RESPONSES_API_ALLOWLIST = new Set([
  "model", "input", "instructions", "tools", "tool_choice", "stream", "store",
  "reasoning", "service_tier", "include", "prompt_cache_key", "client_metadata", "text",
]);

// Server-generated item id prefixes that Codex /responses cannot resolve when store=false
const SERVER_ID_PATTERN = /^(rs|fc|resp|msg)_/;
// ─── Inlined: codex/quota.ts ────────────────────────────────────────────────
// Quota parsing + reset/cooldown scheduling (pure).

/**
 * Parsed quota snapshot from Codex response headers.
 * Codex includes per-account usage windows that allow precise reset scheduling.
 */
// (CodexQuotaSnapshot is a plain object: { usage5h, limit5h, resetAt5h, usage7d, limit7d, resetAt7d })

export function parseCodexQuotaHeaders(headers) {
  const usage5h = headers["x-codex-5h-usage"] ?? null;
  const limit5h = headers["x-codex-5h-limit"] ?? null;
  const resetAt5h = headers["x-codex-5h-reset-at"] ?? null;
  const usage7d = headers["x-codex-7d-usage"] ?? null;
  const limit7d = headers["x-codex-7d-limit"] ?? null;
  const resetAt7d = headers["x-codex-7d-reset-at"] ?? null;

  if (!usage5h && !limit5h && !resetAt5h && !usage7d && !limit7d && !resetAt7d) {
    return null;
  }

  return {
    usage5h: usage5h ? parseFloat(usage5h) : 0,
    limit5h: limit5h ? parseFloat(limit5h) : Infinity,
    resetAt5h: resetAt5h ?? null,
    usage7d: usage7d ? parseFloat(usage7d) : 0,
    limit7d: limit7d ? parseFloat(limit7d) : Infinity,
    resetAt7d: resetAt7d ?? null,
  };
}

export function getCodexResetTime(quota) {
  const times = [];
  if (quota.resetAt7d) {
    const t = new Date(quota.resetAt7d).getTime();
    if (!isNaN(t) && t > Date.now()) times.push(t);
  }
  if (quota.resetAt5h) {
    const t = new Date(quota.resetAt5h).getTime();
    if (!isNaN(t) && t > Date.now()) times.push(t);
  }
  if (times.length === 0) return null;
  return Math.max(...times);
}

export function getCodexDualWindowCooldownMs(quota, threshold = 0.95) {
  const now = Date.now();
  const ratio7d = quota.limit7d > 0 && Number.isFinite(quota.limit7d) ? quota.usage7d / quota.limit7d : 0;
  const ratio5h = quota.limit5h > 0 && Number.isFinite(quota.limit5h) ? quota.usage5h / quota.limit5h : 0;

  if (ratio7d >= threshold && quota.resetAt7d) {
    const resetTime = new Date(quota.resetAt7d).getTime();
    if (resetTime > now) return { cooldownMs: resetTime - now, window: "7d" };
  }
  if (ratio5h >= threshold && quota.resetAt5h) {
    const resetTime = new Date(quota.resetAt5h).getTime();
    if (resetTime > now) return { cooldownMs: resetTime - now, window: "5h" };
  }
  return { cooldownMs: 0, window: "none" };
}

// ─── Inlined: codex/tools.ts ────────────────────────────────────────────────
// Codex Responses-API tool normalization (hosted-tool passthrough + free-plan gating).

export const CODEX_HOSTED_TOOL_TYPES = new Set([
  "tool_search", "image_generation", "web_search", "web_search_preview",
  "file_search", "computer", "computer_use_preview", "code_interpreter", "mcp",
]);

export function isCodexFreePlan(providerSpecificData) {
  if (!providerSpecificData || typeof providerSpecificData !== "object") return false;
  const plan = providerSpecificData.workspacePlanType;
  return typeof plan === "string" && plan.trim().toLowerCase() === "free";
}

export function normalizeCodexTools(body, options) {
  if (!Array.isArray(body.tools)) return;
  const dropImageGen = options?.dropImageGeneration;
  const preserveCustom = options?.preserveCustomTools;

  const validToolNames = new Set();
  body.tools = body.tools.filter((toolValue) => {
    if (!toolValue || typeof toolValue !== "object" || Array.isArray(toolValue)) return false;

    const toolType = typeof toolValue.type === "string" ? toolValue.type : "";

    // Preserve namespace tools (MCP tool groups)
    if (toolType === "namespace") {
      if (Array.isArray(toolValue.tools)) {
        for (const st of toolValue.tools) {
          if (st && typeof st === "object" && !Array.isArray(st)) {
            const name = typeof st.name === "string" ? st.name.trim().slice(0, 128) : "";
            if (name) validToolNames.add(name);
          }
        }
      }
      return true;
    }

    // Native Codex clients send Responses API custom tools (apply_patch etc.)
    if (toolType === "custom" && preserveCustom === true) {
      const name = typeof toolValue.name === "string" ? toolValue.name.trim().slice(0, 128) : "";
      if (!name) return false;
      toolValue.name = name;
      validToolNames.add(name);
      return true;
    }

    if (toolType !== "function") {
      // Not a function tool — check if it's a known hosted tool
      const hasFunctionObject = toolValue.function && typeof toolValue.function === "object";
      const hasName = typeof toolValue.name === "string";
      if (!toolType || hasFunctionObject || hasName) return false;
      if (CODEX_HOSTED_TOOL_TYPES.has(toolType)) {
        if (toolType === "image_generation" && dropImageGen) return false;
        return true;
      }
      console.debug(`[Codex] dropping unknown hosted tool type: ${toolType}`);
      return false;
    }

    // Function tool — flatten Chat Completions shape into Responses flat format
    const rawName = typeof toolValue.name === "string"
      ? toolValue.name
      : toolValue.function && typeof toolValue.function === "object" && !Array.isArray(toolValue.function) && typeof toolValue.function.name === "string"
        ? toolValue.function.name
        : "";
    const name = rawName.trim();
    if (!name) return false;

    const fn = toolValue.function && typeof toolValue.function === "object" && !Array.isArray(toolValue.function)
      ? toolValue.function : null;
    const description = typeof toolValue.description === "string"
      ? toolValue.description
      : typeof fn?.description === "string" ? fn.description : "";
    const parameters = (toolValue.parameters && typeof toolValue.parameters === "object" && !Array.isArray(toolValue.parameters))
      ? toolValue.parameters
      : (fn?.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters)
        ? fn.parameters
        : { type: "object", properties: {} });
    const strict = typeof toolValue.strict === "boolean"
      ? toolValue.strict
      : typeof fn?.strict === "boolean" ? fn.strict : undefined;

    // Rewrite in-place to Responses format
    for (const key of Object.keys(toolValue)) delete toolValue[key];
    toolValue.type = "function";
    toolValue.name = name.slice(0, 128);
    if (description) toolValue.description = description;
    toolValue.parameters = parameters;
    if (strict !== undefined) toolValue.strict = strict;

    validToolNames.add(name);
    return true;
  });

  // Drop tool_choice if it references an unknown function name
  if (body.tool_choice && typeof body.tool_choice === "object" && !Array.isArray(body.tool_choice)) {
    if (body.tool_choice.type === "function") {
      const n = typeof body.tool_choice.name === "string" ? body.tool_choice.name.trim() : "";
      if (!n || !validToolNames.has(n)) delete body.tool_choice;
    } else if (body.tool_choice.type === "local_shell") {
      delete body.tool_choice;
    }
  }
}
// ─── Core utility functions ─────────────────────────────────────────────────

// wreq-js is a Rust-native module that requires platform-specific .node binaries.
// Lazy-load with try/catch to gracefully fall back to HTTP when WebSocket unavailable.
const _wreqRequire = createRequire(import.meta.url);

let _websocketFn = null;
let _wreqChecked = false;
let _websocketOverride;

function getCodexWebSocketTransport() {
  if (_websocketOverride !== undefined) return _websocketOverride;
  if (_wreqChecked) return _websocketFn;
  _wreqChecked = true;
  try {
    const mod = _wreqRequire("wreq-js");
    _websocketFn = typeof mod.websocket === "function" ? mod.websocket : null;
  } catch {
    console.warn("[codex] wreq-js import failed, websocket disabled");
    _websocketFn = null;
  }
  return _websocketFn;
}

export function __setCodexWebSocketTransportForTesting(websocket) {
  _websocketOverride = websocket;
}

function codexWebSocketUnavailableResponse() {
  return new Response(
    JSON.stringify({
      error: {
        code: "wreq_unavailable",
        message: "Codex WebSocket transport unavailable: wreq-js native module is missing for this platform",
      },
    }),
    {
      status: 503,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    },
  );
}

function splitCodexReasoningSuffix(model) {
  const modelId = typeof model === "string" ? model : "";
  for (const level of EFFORT_ORDER) {
    if (modelId.endsWith(`-${level}`)) {
      return { baseModel: modelId.slice(0, -`-${level}`.length), effort: level };
    }
  }
  return { baseModel: modelId, effort: null };
}

export function getCodexUpstreamModel(model) {
  return splitCodexReasoningSuffix(model).baseModel;
}

// Convert role=system → role=developer in body.input (GPT-5 cache-aware)
function convertSystemToDeveloperRole(body) {
  if (!Array.isArray(body.input)) return;
  for (const itemValue of body.input) {
    if (!itemValue || typeof itemValue !== "object" || Array.isArray(itemValue)) continue;
    const role = typeof itemValue.role === "string" ? itemValue.role : "";
    const type = typeof itemValue.type === "string" ? itemValue.type : "";
    if (role === "system" && (!type || type === "message")) {
      itemValue.role = "developer";
    }
  }
}

// Strip server-generated item IDs from input — avoids 404 with store=false.
// Also strips reasoning blobs and empty input repair.
export function stripStoredItemReferences(body) {
  if (Array.isArray(body.input) && body.input.length === 0) {
    body.input = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
    ];
  }
  if (!Array.isArray(body.input)) return;

  let strippedCount = 0;
  body.input = body.input.filter((item) => {
    // Bare string references: "rs_abc123"
    if (typeof item === "string" && SERVER_ID_PATTERN.test(item)) {
      strippedCount++;
      return false;
    }
    // Object references: { type: "item_reference", id: "rs_..." }
    if (item && typeof item === "object" && !Array.isArray(item) && item.type === "item_reference") {
      strippedCount++;
      return false;
    }
    // Reasoning blobs (encrypted_content) unusable with store=false
    if (item && typeof item === "object" && !Array.isArray(item) && item.type === "reasoning") {
      strippedCount++;
      return false;
    }
    // Object items with server-generated IDs: strip the id field but keep the item
    if (item && typeof item === "object" && !Array.isArray(item)) {
      if (typeof item.id === "string" && SERVER_ID_PATTERN.test(item.id)) {
        delete item.id;
        strippedCount++;
      }
    }
    return true;
  });

  if (strippedCount > 0) {
    console.debug(`[Codex] stripStoredItemReferences: sanitized ${strippedCount} server-generated ID(s) from input`);
  }
}

// Repair missing function_call_output items (some clients omit them)
function repairMissingCodexFunctionCallOutputs(body) {
  if (!Array.isArray(body.input)) return;
  const existingOutputIds = new Set();
  for (const item of body.input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (item.type !== "function_call_output") continue;
    if (typeof item.call_id === "string" && item.call_id.trim()) {
      existingOutputIds.add(item.call_id.trim());
    }
  }
  const repaired = [];
  let insertedCount = 0;
  for (const item of body.input) {
    repaired.push(item);
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (item.type !== "function_call") continue;
    const callId = typeof item.call_id === "string" ? item.call_id.trim() : "";
    if (!callId || existingOutputIds.has(callId)) continue;
    repaired.push({ type: "function_call_output", call_id: callId, output: "" });
    existingOutputIds.add(callId);
    insertedCount++;
  }
  if (insertedCount > 0) {
    body.input = repaired;
    console.debug(`[Codex] repairMissingCodexFunctionCallOutputs: inserted ${insertedCount} empty function_call_output item(s)`);
  }
}

function getResponsesSubpath(endpointPath) {
  let normalizedEndpoint = String(endpointPath || "");
  while (normalizedEndpoint.endsWith("/") && normalizedEndpoint.length > 0) {
    normalizedEndpoint = normalizedEndpoint.slice(0, -1);
  }
  const lower = normalizedEndpoint.toLowerCase();
  if (lower === "responses" || lower.endsWith("/responses")) return "";
  const responsesSlash = "/responses/";
  const idx = lower.lastIndexOf(responsesSlash);
  if (idx !== -1) return normalizedEndpoint.slice(idx + "/responses".length);
  if (lower.startsWith("responses/")) return normalizedEndpoint.slice("responses".length);
  return null;
}

export function isCompactResponsesEndpoint(endpointPath) {
  return getResponsesSubpath(endpointPath)?.toLowerCase() === "/compact";
}

function normalizeServiceTierValue(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "fast") return CODEX_FAST_WIRE_VALUE;
  return normalized;
}

function normalizeEffortValue(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "max") return "xhigh";
  return normalized || undefined;
}

function clampEffort(model, requested) {
  const max = MAX_EFFORT_BY_MODEL[model] ?? "xhigh";
  const reqIdx = EFFORT_ORDER.indexOf(requested);
  const maxIdx = EFFORT_ORDER.indexOf(max);
  if (reqIdx > maxIdx) {
    console.debug(`[Codex] clampEffort: "${requested}" → "${max}" (model: ${model})`);
    return max;
  }
  return requested;
}

function ensureCodexReasoningSummary(body) {
  const reasoning = body.reasoning && typeof body.reasoning === "object" && !Array.isArray(body.reasoning)
    ? body.reasoning : null;
  if (!reasoning || normalizeEffortValue(reasoning.effort) === "none") return;
  if (!("summary" in reasoning)) reasoning.summary = CODEX_DEFAULT_REASONING_SUMMARY;
  if (!Array.isArray(body.include)) {
    body.include = [CODEX_REASONING_ENCRYPTED_CONTENT_INCLUDE];
    return;
  }
  if (!body.include.includes(CODEX_REASONING_ENCRYPTED_CONTENT_INCLUDE)) {
    body.include = [...body.include, CODEX_REASONING_ENCRYPTED_CONTENT_INCLUDE];
  }
}

function consumeResponsesStoreMarker(body) {
  const marker = body._omnirouteResponsesStore;
  delete body._omnirouteResponsesStore;
  return marker;
}

// Global Codex WebSocket kill-switch (default ON in AMRouter)
function isCodexWsGloballyEnabled() {
  try {
    const v = process.env.AMROUTER_CODEX_WS_ENABLED;
    if (v === "false" || v === "0") return false;
  } catch { /* noop */ }
  return true;
}

export function isCodexResponsesWebSocketRequired(_model, credentials) {
  if (!isCodexWsGloballyEnabled()) return false;
  const psd = credentials && typeof credentials === "object" ? credentials.providerSpecificData : null;
  return !!(psd?.codexTransport === "websocket" && getCodexWebSocketTransport());
}

function toStatusCode(value) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599) return value;
  if (typeof value === "string" && /^\d{3}$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return parsed >= 400 && parsed <= 599 ? parsed : null;
  }
  return null;
}

function looksLikeQuotaOrRateLimit(code, type, message) {
  const haystack = `${code} ${type} ${message}`.toLowerCase();
  return (
    haystack.includes("usage_limit_reached") ||
    haystack.includes("rate_limit") ||
    haystack.includes("rate limit") ||
    haystack.includes("quota") ||
    haystack.includes("too many requests") ||
    haystack.includes("limit has been reached") ||
    haystack.includes("limit reached")
  );
}

function toCodexResponseFailedEvent(parsed) {
  const response = parsed.response && typeof parsed.response === "object" && !Array.isArray(parsed.response)
    ? parsed.response : null;
  const upstreamError = response?.error && typeof response.error === "object" && !Array.isArray(response.error)
    ? response.error
    : parsed.error && typeof parsed.error === "object" && !Array.isArray(parsed.error)
      ? parsed.error
      : parsed;
  const code = typeof upstreamError.code === "string" ? upstreamError.code
    : typeof upstreamError.type === "string" ? upstreamError.type : "upstream_error";
  const type = typeof upstreamError.type === "string" ? upstreamError.type : "";
  const message = typeof upstreamError.message === "string" && upstreamError.message.trim()
    ? upstreamError.message : "Codex upstream error";
  const error = { code, message };
  const explicitStatus = toStatusCode(parsed.status_code) ?? toStatusCode(parsed.status) ??
    toStatusCode(response?.status_code) ?? toStatusCode(response?.status) ??
    toStatusCode(upstreamError.status_code) ?? toStatusCode(upstreamError.status);
  const statusCode = explicitStatus ?? (looksLikeQuotaOrRateLimit(code, type, message) ? 429 : null);
  if (type) error.type = type;
  if (statusCode !== null) error.status_code = statusCode;
  return {
    type: "response.failed",
    response: { id: typeof response?.id === "string" ? response.id : null, status: "failed", error },
  };
}

// Env-gated kill-switch: drop non-standard codex.* SSE events
function codexDropNonstandardEvents() {
  const v = process.env.AMROUTER_CODEX_DROP_NONSTANDARD_EVENTS;
  return v === "true" || v === "1" || v === "yes";
}

export function filterNonstandardCodexSse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!response.body || !contentType.includes("text/event-stream")) return response;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const dropBlock = (block) => {
    const match = /^event:\s*(.+)$/m.exec(block);
    return !!match && match[1].trim().startsWith("codex.");
  };
  const transform = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep + 2);
        buffer = buffer.slice(sep + 2);
        if (!dropBlock(block)) controller.enqueue(encoder.encode(block));
      }
    },
    flush(controller) {
      if (buffer && !dropBlock(buffer)) controller.enqueue(encoder.encode(buffer));
    },
  });
  return new Response(response.body.pipeThrough(transform), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function encodeResponseSseEvent(raw) {
  let eventType = "message";
  let payload = raw;
  let terminal = false;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.type === "string" && parsed.type.trim()) {
      eventType = parsed.type.trim();
      if (eventType === "error" || eventType === "response.failed") {
        const failed = toCodexResponseFailedEvent(parsed);
        payload = JSON.stringify(failed);
        eventType = "response.failed";
      }
      terminal = eventType === "response.completed" || eventType === "response.failed";
    }
  } catch {
    console.warn("[codex] SSE payload parse failed, using raw payload");
  }
  if (eventType.startsWith("codex.") && codexDropNonstandardEvents()) {
    return { sse: "", terminal };
  }
  if (!payload.trim()) return { sse: "", terminal };
  return { sse: `event: ${eventType}\ndata: ${payload}\n\n`, terminal };
}

function toWebSocketUrl(url) {
  if (/^wss?:\/\//.test(url)) return url;
  if (url.startsWith("https:")) return url.replace(/^https:/, "wss:");
  if (url.startsWith("http:")) return url.replace(/^http:/, "ws:");
  return CODEX_RESPONSES_WS_URL;
}

function normalizeCodexWsHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === "host" || lower === "connection" || lower === "upgrade" ||
        lower === "sec-websocket-key" || lower === "sec-websocket-version" ||
        lower === "sec-websocket-extensions") continue;
    result[key] = value;
  }
  result.Origin = "https://chatgpt.com";
  return result;
}

// Resolve prompt-cache session id for AMRouter
function resolveCacheSessionId(body, credentials) {
  return resolveSessionId({
    headers: credentials?.rawHeaders,
    body,
    connectionId: credentials?.connectionId,
    workspaceId: credentials?.providerSpecificData?.workspaceId,
    scope: "codex",
  });
}
// ─── CodexExecutor class ────────────────────────────────────────────────────

export class CodexExecutor extends BaseExecutor {
  constructor() {
    super("codex", PROVIDERS.codex);
    this._currentSessionId = null;
  }

  // ── execute: SSE retry loop + WebSocket transport support ──────────────

  async execute(args) {
    const imgCount = Array.isArray(args.body?.input)
      ? args.body.input.reduce((n, it) => n + (Array.isArray(it.content) ? it.content.filter(c => c.type === "image_url").length : 0), 0)
      : 0;
    const inputLen = Array.isArray(args.body?.input) ? args.body.input.length : 0;
    dbg("CODEX", `execute start | inputItems=${inputLen} | images=${imgCount} | sessionId=${this._currentSessionId || "pending"}`);

    // Prefetch remote images as base64 (Codex backend can't fetch them)
    await this.prefetchImages(args.body);

    // WebSocket transport path — opt-in via providerSpecificData.codexTransport
    const sessionId = this.getPromptCacheSessionId(args.credentials, args.body);
    const identity = createCodexClientIdentity(sessionId, args.credentials?.providerSpecificData ?? null);
    const credentials = identity
      ? {
          ...args.credentials,
          providerSpecificData: {
            ...(args.credentials?.providerSpecificData || {}),
            codexClientIdentity: identity,
          },
        }
      : args.credentials;
    const nextArgs = { ...args, credentials };

    if (!isCodexResponsesWebSocketRequired(nextArgs.model, nextArgs.credentials)) {
      // HTTP SSE path with retry loop
      return this._executeWithRetry(nextArgs);
    }

    // WebSocket path
    return this._executeWebSocket(nextArgs);
  }

  async _executeWithRetry(args) {
    // Retry loop for SSE-level overloaded errors (200 OK body contains event: error)
    const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };
    const { attempts, delayMs } = resolveRetryEntry(retryConfig[503]);
    let attempt = 0;
    while (true) {
      const result = await super.execute(args);
      const peek = await this._peekSseTransientError(result.response);
      if (!peek.matched) {
        if (peek.replacementBody) {
          result.response = new Response(peek.replacementBody, {
            status: result.response.status,
            statusText: result.response.statusText,
            headers: result.response.headers,
          });
        }
        // Filter non-standard codex.* events if kill-switch is on
        if (codexDropNonstandardEvents()) {
          const resp = result.response;
          if (resp?.body) {
            result.response = filterNonstandardCodexSse(resp);
          }
        }
        return result;
      }
      if (peek.accountFallback) {
        args.log?.warn?.("RETRY", `CODEX | SSE account fallback "${peek.message}"`);
        result.response = this._codexSseErrorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, peek.message || "Selected model is at capacity.");
        return result;
      }
      if (attempt >= attempts) {
        args.log?.warn?.("RETRY", `CODEX | SSE overloaded "${peek.matched}" — retries exhausted (${attempt}/${attempts})`);
        result.response = this._codexSseErrorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, peek.message || peek.matched);
        return result;
      }
      attempt++;
      args.log?.debug?.("RETRY", `CODEX | SSE "${peek.matched}" retry ${attempt}/${attempts} after ${delayMs / 1000}s`);
      dbg("CODEX", `SSE overloaded "${peek.matched}" → retry ${attempt}/${attempts} in ${delayMs}ms`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  async _executeWebSocket(args) {
    const url = CODEX_RESPONSES_WS_URL;
    const headers = normalizeCodexWsHeaders(this.buildHeaders(args.credentials, true));

    // Merge extra headers if provided
    if (args.upstreamExtraHeaders && typeof args.upstreamExtraHeaders === "object") {
      for (const [k, v] of Object.entries(args.upstreamExtraHeaders)) {
        if (typeof v === "string") headers[k] = v;
      }
    }

    const transformedBody = await this.transformRequest(args.model, args.body, true, args.credentials);
    transformedBody.model = getCodexUpstreamModel(transformedBody.model || args.model);
    delete transformedBody.stream;
    delete transformedBody.stream_options;

    const bodyString = JSON.stringify({ type: "response.create", ...transformedBody });

    const websocketFn = getCodexWebSocketTransport();
    if (!websocketFn) {
      return { response: codexWebSocketUnavailableResponse(), url, headers, transformedBody };
    }

    const encoder = new TextEncoder();
    let closed = false;
    let ws = null;
    let streamController = null;

    const closeUpstream = (reason) => {
      try { ws?.close(1000, reason); } catch { /* ignore close races */ }
    };

    let abortHandler = null;
    const removeAbortListener = () => {
      if (!abortHandler) return;
      args.signal?.removeEventListener("abort", abortHandler);
      abortHandler = null;
    };

    const finishStream = ({ reason, emitDone = true, closeController = true, closeSocket = true }) => {
      if (closed) return;
      closed = true;
      removeAbortListener();
      if (closeSocket) closeUpstream(reason);
      const controller = streamController;
      if (!controller || !closeController) return;
      if (emitDone) {
        try { controller.enqueue(encoder.encode("data: [DONE]\n\n")); } catch { /* downstream may be gone */ }
      }
      try { controller.close(); } catch { /* controller may already be closed */ }
    };

    const failController = (code, message) => {
      if (closed) return;
      const controller = streamController;
      const payload = JSON.stringify({
        type: "response.failed",
        response: { id: null, status: "failed", error: { code, message } },
      });
      try { controller?.enqueue(encoder.encode(`event: response.failed\ndata: ${payload}\n\n`)); } catch { /* downstream closed */ }
      finishStream({ reason: "upstream_failed" });
    };

    const stream = new ReadableStream({
      async start(controller) {
        streamController = controller;
        abortHandler = () => finishStream({ reason: "client_aborted" });
        args.signal?.addEventListener("abort", abortHandler, { once: true });

        try {
          ws = await websocketFn(toWebSocketUrl(url), { browser: "chrome_142", os: "windows", headers });
          if (closed) return;
          if (args.signal?.aborted) { finishStream({ reason: "client_aborted" }); return; }

          ws.onmessage = (event) => {
            if (closed) return;
            const raw = typeof event.data === "string"
              ? event.data
              : Buffer.from(event.data).toString("utf8");
            const sseEvent = encodeResponseSseEvent(raw);
            if (closed) return;
            if (sseEvent.sse) {
              try { controller.enqueue(encoder.encode(sseEvent.sse)); } catch {
                finishStream({ reason: "downstream_closed", emitDone: false, closeController: false });
                return;
              }
            }
            if (sseEvent.terminal) finishStream({ reason: "terminal_event" });
          };
          ws.onerror = (event) => {
            failController("upstream_websocket_error", event.message || "Codex upstream WebSocket error");
          };
          ws.onclose = () => {
            finishStream({ reason: "upstream_closed", closeSocket: false });
          };
          if (!closed) {
            await prl.captureCurrentProviderBody(url, headers, bodyString, args.log);
            ws.send(bodyString);
          }
        } catch (error) {
          failController("upstream_websocket_connect_failed", error instanceof Error ? error.message : String(error));
        }
      },
      cancel() {
        finishStream({ reason: "client_cancelled", emitDone: false, closeController: false });
      },
    });

    return {
      response: new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      }),
      url, headers, transformedBody,
    };
  }

  // ── Prefetch remote images as base64 ──────────────────────────────────

  async prefetchImages(body) {
    if (!Array.isArray(body?.input)) return;
    for (const item of body.input) {
      if (!Array.isArray(item.content)) continue;
      const pending = item.content.map(async (c) => {
        if (c.type !== "image_url") return c;
        const url = typeof c.image_url === "string" ? c.image_url : c.image_url?.url;
        const detail = c.image_url?.detail || "auto";
        if (!url) return c;
        if (url.startsWith("data:")) return { type: "input_image", image_url: url, detail };
        const fetched = await fetchImageAsBase64(url, { timeoutMs: 15000 });
        return { type: "input_image", image_url: fetched?.url || url, detail };
      });
      item.content = await Promise.all(pending);
    }
  }

  // ── SSE transient error peek ──────────────────────────────────────────

  async _peekSseTransientError(response) {
    const CODEX_SSE_RETRY_PATTERNS = ["server_is_overloaded", "service_unavailable_error"];
    const CODEX_SSE_ACCOUNT_FALLBACK_PATTERNS = ["selected model is at capacity", "model_at_capacity"];
    const CODEX_SSE_USER_OUTPUT_PATTERNS = [
      "event: response.output_text.delta", "event: response.function_call_arguments.delta",
      '"type":"response.output_text.delta"', '"type":"response.function_call_arguments.delta"',
    ];
    const CODEX_SSE_PEEK_BYTES = 256 * 1024;

    if (!response || !response.ok || !response.body) return { matched: null, message: null, accountFallback: false, replacementBody: null };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks = [];
    let text = "";
    let matched = null;
    let accountFallback = false;
    try {
      while (text.length < CODEX_SSE_PEEK_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        text += decoder.decode(value, { stream: true });
        const lowerText = text.toLowerCase();
        const accountHit = CODEX_SSE_ACCOUNT_FALLBACK_PATTERNS.find(p => lowerText.includes(p));
        if (accountHit) { matched = accountHit; accountFallback = true; break; }
        const retryHit = CODEX_SSE_RETRY_PATTERNS.find(p => lowerText.includes(p));
        if (retryHit) { matched = retryHit; break; }
        if (CODEX_SSE_USER_OUTPUT_PATTERNS.some(p => lowerText.includes(p))) break;
      }
    } catch (e) {
      dbg("CODEX", `peek read error: ${e.message}`);
    }

    if (matched) {
      try { await reader.cancel(); } catch { /* noop */ }
      try { reader.releaseLock(); } catch { /* noop */ }
      return { matched, message: this._extractSseErrorMessage(text, matched), accountFallback, replacementBody: null };
    }

    reader.releaseLock();
    const upstream = response.body;
    let upstreamReader = null;
    const replacementBody = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        upstreamReader = upstream.getReader();
      },
      async pull(controller) {
        try {
          const { done, value } = await upstreamReader.read();
          if (done) { controller.close(); return; }
          controller.enqueue(value);
        } catch (e) { controller.error(e); }
      },
      cancel(reason) {
        try { upstreamReader?.cancel(reason); } catch { /* noop */ }
      },
    });
    return { matched: null, message: null, accountFallback: false, replacementBody };
  }

  _extractSseErrorMessage(text, fallback) {
    const exact = text?.match(/Selected model is at capacity\. Please try a different model\./i)?.[0];
    if (exact) return exact;
    for (const line of String(text || "").split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data);
        const message = this._findNestedMessage(parsed);
        if (message) return message;
      } catch { /* Ignore non-JSON */ }
    }
    return fallback || "Selected model is at capacity. Please try a different model.";
  }

  _findNestedMessage(value, depth = 0) {
    if (!value || depth > 6 || typeof value === "string") return null;
    if (Array.isArray(value)) {
      for (const item of value) { const f = this._findNestedMessage(item, depth + 1); if (f) return f; }
      return null;
    }
    if (typeof value !== "object") return null;
    if (typeof value.message === "string" && value.message.trim()) return value.message;
    if (typeof value.error?.message === "string" && value.error.message.trim()) return value.error.message;
    if (typeof value.response?.error?.message === "string" && value.response.error.message.trim()) return value.response.error.message;
    for (const child of Object.values(value)) { const f = this._findNestedMessage(child, depth + 1); if (f) return f; }
    return null;
  }

  _codexSseErrorResponse(status, message) {
    return new Response(JSON.stringify({
      error: {
        message,
        type: status >= 500 ? "server_error" : "invalid_request_error",
        code: status === HTTP_STATUS.SERVICE_UNAVAILABLE ? "service_unavailable" : "upstream_error",
      },
    }), { status, headers: { "Content-Type": "application/json" } });
  }

  // ── Header / URL builders ─────────────────────────────────────────────

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    const responsesSubpath = getResponsesSubpath(credentials?.requestEndpointPath);
    if (responsesSubpath !== null) {
      const baseUrl = String(this.config.baseUrl || "").replace(/\/$/, "");
      if (baseUrl.endsWith("/responses")) return `${baseUrl}${responsesSubpath}`;
      return `${baseUrl}/responses${responsesSubpath}`;
    }
    if (this._isCompact) {
      const base = super.buildUrl(model, stream, urlIndex, credentials);
      return `${base}/compact`;
    }
    return super.buildUrl(model, stream, urlIndex, credentials);
  }

  buildHeaders(credentials, stream = true) {
    const isCompactRequest = isCompactResponsesEndpoint(credentials?.requestEndpointPath);
    const headers = super.buildHeaders(credentials, isCompactRequest ? false : true);

    // Codex client version + user agent
    headers["Version"] = getCodexClientVersion();
    headers["User-Agent"] = getCodexUserAgent();

    // Workspace binding header
    const workspaceId = credentials?.providerSpecificData?.workspaceId;
    if (typeof workspaceId === "string" && workspaceId) {
      headers["chatgpt-account-id"] = workspaceId;
    }

    // Also support chatgptAccountId / accountId as fallback
    const accountId = credentials?.providerSpecificData?.chatgptAccountId || credentials?.providerSpecificData?.accountId;
    if (typeof accountId === "string" && accountId && !headers["chatgpt-account-id"]) {
      headers["chatgpt-account-id"] = accountId;
    }

    // Originator header — identifies the client type to Codex backend
    if (!headers["originator"]) headers["originator"] = "codex_cli_rs";

    // Session ID for prompt cache affinity
    const cacheSessionId = this.getPromptCacheSessionId(credentials, null);
    if (cacheSessionId) headers["session_id"] = cacheSessionId;

    // Client identity headers
    const clientIdentity = credentials?.providerSpecificData?.codexClientIdentity;
    applyCodexClientIdentityHeaders(headers, clientIdentity);

    return headers;
  }

  // ── Prompt cache session ID ───────────────────────────────────────────

  getPromptCacheSessionId(credentials, body) {
    const promptCacheKey = normalizeCodexSessionId(body?.prompt_cache_key);
    if (promptCacheKey) return promptCacheKey;

    const sessionId = body?.session_id ?? body?.conversation_id;
    const normalizedSessionId = normalizeCodexSessionId(sessionId);
    if (normalizedSessionId) return normalizedSessionId;

    // AMRouter: use resolveSessionId for stable session IDs
    if (credentials) {
      return resolveCacheSessionId(body || {}, credentials);
    }
    return normalizeCodexSessionId(credentials?.providerSpecificData?.workspaceId) || null;
  }

  // ── Credential refresh ────────────────────────────────────────────────

  async refreshCredentials(credentials, log) {
    if (!credentials?.refreshToken) {
      log?.warn?.("TOKEN_REFRESH", "Codex: no refresh token available, re-authentication required");
      return null;
    }
    // Try AMRouter's refreshProviderCredentials first
    try {
      const result = await refreshProviderCredentials("codex", credentials, log);
      if (result) return result;
    } catch { /* fall through to getAccessToken */ }

    // Fallback to getAccessToken
    const result = await getAccessToken("codex", credentials, log);
    if (!result) {
      log?.warn?.("TOKEN_REFRESH", "Codex: token refresh failed — re-authentication required");
      return null;
    }
    if (result.error) {
      log?.warn?.("TOKEN_REFRESH", `Codex: token refresh failed (${result.error}) — re-authentication required`);
      return null;
    }
    return result;
  }

  needsRefresh(credentials) {
    return shouldRefreshCredentials("codex", credentials);
  }

  // ── Parse 429 with usage_limit_reached ────────────────────────────────

  parseError(response, bodyText) {
    if (response.status === 429 && bodyText) {
      try {
        const json = JSON.parse(bodyText);
        const err = json?.error;
        if (err?.type === "usage_limit_reached") {
          const now = Date.now();
          let resetsAtMs = null;
          if (typeof err.resets_at === "number" && err.resets_at > 0) {
            const ms = err.resets_at * 1000;
            if (ms > now) resetsAtMs = ms;
          }
          if (!resetsAtMs && typeof err.resets_in_seconds === "number" && err.resets_in_seconds > 0) {
            resetsAtMs = now + err.resets_in_seconds * 1000;
          }
          if (resetsAtMs) return { status: 429, message: err.message || bodyText, resetsAtMs };
        }
      } catch { /* fall through */ }
    }
    return super.parseError(response, bodyText);
  }

  // ── Transform request (main business logic) ───────────────────────────

  transformRequest(model, bodyInput, stream, credentials) {
    this._isCompact = !!bodyInput?._compact;
    // Do not mutate the caller's payload in place
    const body = bodyInput && typeof bodyInput === "object"
      ? structuredClone(bodyInput)
      : {};

    const nativeCodexPassthrough = body?._nativeCodexPassthrough === true;
    const isCompactRequest = isCompactResponsesEndpoint(credentials?.requestEndpointPath);
    const requestDefaults = getCodexRequestDefaults(credentials?.providerSpecificData);
    const thinkingBudgetConfig = getThinkingBudgetConfig();
    const allowConnectionReasoningDefaults = thinkingBudgetConfig.mode === ThinkingMode.PASSTHROUGH;
    consumeResponsesStoreMarker(body);

    // Resolve conversation-stable session_id
    this._currentSessionId = this.getPromptCacheSessionId(credentials, body);

    // Codex /responses rejects stream=false, but /responses/compact rejects the stream field entirely
    if (isCompactRequest) {
      delete body.stream;
      delete body.stream_options;
      delete body.client_metadata;
    } else {
      body.stream = true;
    }
    delete body._nativeCodexPassthrough;
    delete body._compact;

    const requestServiceTier = normalizeServiceTierValue(body.service_tier);
    if (requestServiceTier) {
      body.service_tier = requestServiceTier;
    } else if (requestDefaults.serviceTier) {
      body.service_tier = requestDefaults.serviceTier;
    }

    // Messages/prompt → input conversion (must run before role conversion + strip)
    normalizeCodexResponsesInput(body);

    // Normalize string input to array format
    const normalized = normalizeResponsesInput(body.input);
    if (normalized) body.input = normalized;

    // Ensure input is present and non-empty
    if (!body.input || (Array.isArray(body.input) && body.input.length === 0)) {
      body.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] }];
    }

    if (Array.isArray(body.input)) {
      body.input = sanitizeResponsesInputItems(body.input, false, {
        dropInternalAssistantMessages: !nativeCodexPassthrough,
      });
    }
    repairMissingCodexFunctionCallOutputs(body);

    // Cache-aware system → developer role conversion
    convertSystemToDeveloperRole(body);

    if (nativeCodexPassthrough) {
      if (!body.instructions || (typeof body.instructions === "string" && body.instructions.trim() === "")) {
        body.instructions = "Follow the developer instructions in the conversation.";
      }
    } else {
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      if (!body.instructions || (typeof body.instructions === "string" && body.instructions.trim() === "")) {
        body.instructions = hasTools ? CODEX_DEFAULT_INSTRUCTIONS : CODEX_CHAT_DEFAULT_INSTRUCTIONS;
      }
    }

    // Store: regular Codex rejects store=true; compact rejects the field entirely
    const explicitStoreSetting = credentials?.providerSpecificData?.openaiStoreEnabled;
    if (isCompactRequest) {
      delete body.store;
    } else if (explicitStoreSetting === true) {
      body.store = true;
    } else {
      body.store = false;
    }

    // Normalize tools (hosted tool passthrough, free-plan gating)
    normalizeCodexTools(body, {
      dropImageGeneration: isCodexFreePlan(credentials?.providerSpecificData),
      preserveCustomTools: nativeCodexPassthrough,
    });

    // Strip stored item references
    stripStoredItemReferences(body);

    // Clean up messages/prompt fields
    delete body.messages;
    delete body.prompt;

    // Map virtual Codex review models to upstream
    if (typeof body.model === "string") {
      body.model = getModelUpstreamId("cx", body.model) || body.model;
    }

    // Extract thinking level from model name suffix
    let modelEffort = null;
    let cleanModel = typeof body.model === "string" ? body.model : model;
    const splitModel = splitCodexReasoningSuffix(cleanModel);
    if (splitModel.effort) {
      modelEffort = splitModel.effort;
      body.model = splitModel.baseModel;
      cleanModel = splitModel.baseModel;
    }

    // Reasoning effort: model suffix > explicit reasoning.effort > reasoning_effort > defaults
    const reasoningRecord = body.reasoning && typeof body.reasoning === "object" && !Array.isArray(body.reasoning)
      ? body.reasoning : null;
    const explicitReasoning = normalizeEffortValue(reasoningRecord?.effort);
    const requestReasoningEffort = normalizeEffortValue(body.reasoning_effort);
    const fallbackReasoningEffort = allowConnectionReasoningDefaults
      ? requestDefaults.reasoningEffort || "medium" : undefined;
    const rawEffort = modelEffort || explicitReasoning || requestReasoningEffort || fallbackReasoningEffort;

    if (rawEffort) {
      body.reasoning = { ...(reasoningRecord || {}), effort: clampEffort(cleanModel, rawEffort) };
    }
    ensureCodexReasoningSummary(body);
    delete body.reasoning_effort;

    // Remove unsupported parameters
    delete body.max_tokens;
    delete body.max_output_tokens;
    delete body.truncation;
    delete body.background;
    delete body.prompt_cache_retention;
    delete body.safety_identifier;
    delete body.user;
    delete body.temperature;
    delete body.top_p;
    delete body.frequency_penalty;
    delete body.presence_penalty;
    delete body.logprobs;
    delete body.top_logprobs;
    delete body.n;
    delete body.seed;
    delete body.max_completion_tokens;
    delete body.metadata;
    delete body.stream_options;

    // Inject prompt_cache_key for Codex prompt caching
    if (!body.prompt_cache_key) {
      const cacheSessionId = this.getPromptCacheSessionId(credentials, body);
      if (cacheSessionId) body.prompt_cache_key = cacheSessionId;
    }
    if (!isCompactRequest) {
      applyCodexClientMetadata(body, credentials?.providerSpecificData?.codexClientIdentity);
    }

    // Delete session_id and conversation_id from body (unsupported upstream)
    delete body.session_id;
    delete body.conversation_id;

    // previous_response_id: store=false → backend can't resolve; avoid 404
    delete body.previous_response_id;

    if (nativeCodexPassthrough) return body;

    // GPT-5 verbosity normalization
    normalizeCodexVerbosity(body);

    // Final allowlist filter — strip unknown fields
    for (const key of Object.keys(body)) {
      if (!RESPONSES_API_ALLOWLIST.has(key)) delete body[key];
    }

    return body;
  }
}

export default CodexExecutor;
