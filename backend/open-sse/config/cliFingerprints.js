import { isClaudeCodeCompatible } from "../services/provider.ts";
import {
  getAntigravityUserAgent,
  GITHUB_COPILOT_CHAT_USER_AGENT,
  getQwenOauthHeaders
} from "./providerHeaderProfiles.ts";
import { normalizeCliCompatProviderId } from '../../dist/shared/utils/cliCompat.js';
const CLI_FINGERPRINTS = {
  codex: {
    headerOrder: [
      "Host",
      "Content-Type",
      "Authorization",
      "Accept",
      "User-Agent",
      "Accept-Encoding"
    ],
    bodyFieldOrder: [
      "model",
      "stream",
      "input",
      "instructions",
      "store",
      "reasoning",
      "prompt_cache_key",
      "tools",
      "tool_choice",
      "include",
      "service_tier",
      "client_metadata",
      "parallel_tool_calls",
      "metadata"
    ]
    // Codex builds mode-specific client headers in its executor/config. The CLI fingerprint must
    // only preserve ordering here; overriding User-Agent with a generic value would erase the
    // executor-provided version or user override.
  },
  claude: {
    // Header order matching real claude-cli: Title-Case (Stainless) keys
    // alphabetically, then lowercase Anthropic keys alphabetically, then
    // transport headers added by Node fetch.
    headerOrder: [
      "Accept",
      "Authorization",
      "Content-Type",
      "User-Agent",
      "X-Claude-Code-Session-Id",
      "X-Stainless-Arch",
      "X-Stainless-Lang",
      "X-Stainless-OS",
      "X-Stainless-Package-Version",
      "X-Stainless-Retry-Count",
      "X-Stainless-Runtime",
      "X-Stainless-Runtime-Version",
      "X-Stainless-Timeout",
      "anthropic-beta",
      "anthropic-dangerous-direct-browser-access",
      "anthropic-version",
      "x-app",
      "x-client-request-id",
      "Connection",
      "Host",
      "Accept-Encoding",
      "Content-Length"
    ],
    bodyFieldOrder: [
      "model",
      "messages",
      "system",
      "tools",
      "tool_choice",
      "metadata",
      "max_tokens",
      "temperature",
      "thinking",
      "context_management",
      "output_config",
      "stream"
    ]
  },
  "claude-code-compatible": {
    headerOrder: [
      "Host",
      "Content-Type",
      "Authorization",
      "anthropic-version",
      "anthropic-beta",
      "anthropic-dangerous-direct-browser-access",
      "x-app",
      "User-Agent",
      "X-Claude-Code-Session-Id",
      "X-Stainless-Retry-Count",
      "X-Stainless-Timeout",
      "X-Stainless-Lang",
      "X-Stainless-Package-Version",
      "X-Stainless-OS",
      "X-Stainless-Arch",
      "X-Stainless-Runtime",
      "X-Stainless-Runtime-Version",
      "Accept",
      "accept-encoding",
      "Connection"
    ],
    bodyFieldOrder: [
      "model",
      "messages",
      "system",
      "tools",
      "tool_choice",
      "metadata",
      "max_tokens",
      "thinking",
      "output_config",
      "stream"
    ]
  },
  github: {
    headerOrder: [
      "Host",
      "Authorization",
      "X-Request-Id",
      "Vscode-Sessionid",
      "Vscode-Machineid",
      "Editor-Version",
      "Editor-Plugin-Version",
      "Copilot-Integration-Id",
      "Openai-Organization",
      "Openai-Intent",
      "Content-Type",
      "User-Agent",
      "Accept",
      "Accept-Encoding"
    ],
    bodyFieldOrder: [
      "messages",
      "model",
      "temperature",
      "top_p",
      "max_tokens",
      "n",
      "stream",
      "intent",
      "intent_threshold",
      "intent_content"
    ],
    userAgent: GITHUB_COPILOT_CHAT_USER_AGENT
  },
  antigravity: {
    headerOrder: [
      "Accept",
      "Accept-Encoding",
      "Authorization",
      "Content-Type",
      "User-Agent",
      "x-goog-api-client",
      "x-client-name",
      "x-client-version",
      "x-machine-id",
      "x-vscode-sessionid",
      "Host",
      "Connection"
    ],
    bodyFieldOrder: [
      "project",
      "requestId",
      "request",
      "model",
      "userAgent",
      "requestType",
      "enabledCreditTypes"
    ],
    userAgent: getAntigravityUserAgent
  },
  qwen: {
    headerOrder: [
      "Host",
      "Content-Type",
      "Authorization",
      "User-Agent",
      "X-Dashscope-AuthType",
      "X-Dashscope-CacheControl",
      "X-Dashscope-UserAgent",
      "X-Stainless-Arch",
      "X-Stainless-Lang",
      "X-Stainless-Os",
      "X-Stainless-Package-Version",
      "X-Stainless-Retry-Count",
      "X-Stainless-Runtime",
      "X-Stainless-Runtime-Version",
      "Connection",
      "Accept",
      "Accept-Language",
      "Sec-Fetch-Mode",
      "Accept-Encoding"
    ],
    bodyFieldOrder: [
      "model",
      "messages",
      "temperature",
      "top_p",
      "max_tokens",
      "stream",
      "tools",
      "tool_choice",
      "response_format",
      "n",
      "stop"
    ],
    userAgent: getQwenOauthHeaders()["User-Agent"],
    extraHeaders: getQwenOauthHeaders()
  }
};
function orderFields(obj, fieldOrder) {
  if (!fieldOrder?.length || !obj || typeof obj !== "object") return obj;
  const result = {};
  const remaining = new Set(Object.keys(obj));
  for (const key of fieldOrder) {
    if (key in obj) {
      result[key] = obj[key];
      remaining.delete(key);
    }
  }
  for (const key of remaining) {
    result[key] = obj[key];
  }
  return result;
}
function orderHeaders(headers, headerOrder) {
  if (!headerOrder?.length || !headers) return headers;
  const result = {};
  const remaining = /* @__PURE__ */ new Map();
  const headerMap = /* @__PURE__ */ new Map();
  for (const [key, value] of Object.entries(headers)) {
    headerMap.set(key.toLowerCase(), [key, value]);
  }
  for (const orderedKey of headerOrder) {
    const entry = headerMap.get(orderedKey.toLowerCase());
    if (entry) {
      result[entry[0]] = entry[1];
      headerMap.delete(orderedKey.toLowerCase());
    }
  }
  for (const [, [key, value]] of headerMap) {
    result[key] = value;
  }
  return result;
}
function stripInternalBodyFields(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const record = body;
  delete record._claudeCodeRequiresLowercaseToolNames;
  delete record._nativeCodexPassthrough;
  delete record._omnirouteResponsesStore;
  return body;
}
function applyFingerprint(provider, headers, body) {
  body = stripInternalBodyFields(body);
  const normalizedProvider = normalizeCliCompatProviderId(provider || "");
  const fingerprintKey = isClaudeCodeCompatible(provider) ? "claude-code-compatible" : normalizedProvider;
  const fingerprint = CLI_FINGERPRINTS[fingerprintKey];
  if (!fingerprint) {
    return { headers, bodyString: JSON.stringify(body) };
  }
  if (fingerprint.userAgent) {
    headers["User-Agent"] = typeof fingerprint.userAgent === "function" ? fingerprint.userAgent() : fingerprint.userAgent;
  }
  if (fingerprint.extraHeaders) {
    Object.assign(headers, fingerprint.extraHeaders);
  }
  const orderedHeaders = orderHeaders(headers, fingerprint.headerOrder);
  const orderedBody = body && typeof body === "object" && !Array.isArray(body) ? orderFields(body, fingerprint.bodyFieldOrder) : body;
  return {
    headers: orderedHeaders,
    bodyString: JSON.stringify(orderedBody)
  };
}
let _cliCompatProviders = /* @__PURE__ */ new Set();
function setCliCompatProviders(providers) {
  _cliCompatProviders = new Set(
    (providers || []).map((p) => normalizeCliCompatProviderId(p)).filter((provider) => provider in CLI_FINGERPRINTS)
  );
}
function getCliCompatProviders() {
  return Array.from(_cliCompatProviders);
}
function isCliCompatEnabled(provider) {
  if (isClaudeCodeCompatible(provider)) return true;
  const key = provider?.toLowerCase().replace(/[^a-z0-9]/g, "_");
  const normalizedProvider = normalizeCliCompatProviderId(provider || "");
  if (_cliCompatProviders.has(normalizedProvider)) return true;
  const envKey = `CLI_COMPAT_${key?.toUpperCase()}`;
  if (process.env[envKey] === "1" || process.env[envKey] === "true") return true;
  if (process.env.CLI_COMPAT_ALL === "1" || process.env.CLI_COMPAT_ALL === "true") return true;
  return false;
}
export {
  CLI_FINGERPRINTS,
  applyFingerprint,
  getCliCompatProviders,
  isCliCompatEnabled,
  orderFields,
  orderHeaders,
  setCliCompatProviders
};
