import {
  BaseExecutor,
  mergeUpstreamExtraHeaders,
  mergeAbortSignals
} from "./base.ts";
import { HTTP_STATUS, FETCH_TIMEOUT_MS } from "../config/constants.ts";
import { getProviderPluginManifestHeader } from "../config/providerPluginManifestUrl.ts";
import { cloakThirdPartyToolNames } from "../services/claudeCodeToolRemapper.ts";
import { sanitizeClaudeToolSchemas } from "../translator/helpers/schemaCoercion.ts";
const DEFAULT_PORT = 8317;
const DEFAULT_HOST = "127.0.0.1";
const HEALTH_CHECK_TIMEOUT_MS = 5e3;
const MCP_RESERVED_PREFIX_RE = /^mcp_(?=[^_])/;
function rewriteMcpToolName(name) {
  if (typeof name !== "string" || !MCP_RESERVED_PREFIX_RE.test(name)) return null;
  return "M" + name.slice(1);
}
function applyMcpToolNameRewrite(body) {
  const reverseMap = /* @__PURE__ */ new Map();
  const remember = (original, rewritten) => {
    reverseMap.set(rewritten, original);
  };
  const tools = body.tools;
  if (Array.isArray(tools)) {
    body.tools = tools.map((tool) => {
      if (!tool || typeof tool !== "object") return tool;
      const t = tool;
      const original = typeof t.name === "string" ? t.name : "";
      const rewritten = rewriteMcpToolName(original);
      if (rewritten) {
        remember(original, rewritten);
        return { ...t, name: rewritten };
      }
      return tool;
    });
  }
  const messages = body.messages;
  if (Array.isArray(messages)) {
    body.messages = messages.map((msg) => {
      if (!msg || typeof msg !== "object") return msg;
      const m = msg;
      const content = m.content;
      if (!Array.isArray(content)) return msg;
      let mutated = false;
      const newContent = content.map((block) => {
        if (!block || typeof block !== "object") return block;
        const b = block;
        if (b.type !== "tool_use") return block;
        const original = typeof b.name === "string" ? b.name : "";
        const rewritten = rewriteMcpToolName(original);
        if (rewritten) {
          mutated = true;
          remember(original, rewritten);
          return { ...b, name: rewritten };
        }
        return block;
      });
      return mutated ? { ...m, content: newContent } : msg;
    });
  }
  const toolChoice = body.tool_choice;
  if (toolChoice && typeof toolChoice === "object") {
    const tc = toolChoice;
    if (tc.type === "tool" && typeof tc.name === "string") {
      const rewritten = rewriteMcpToolName(tc.name);
      if (rewritten) {
        const original = tc.name;
        body.tool_choice = { ...tc, name: rewritten };
        remember(original, rewritten);
      }
    }
  }
  return reverseMap;
}
let _cachedSettingsUrl = null;
const URL_CACHE_TTL_MS = 6e4;
function clearCliproxyapiUrlCache() {
  _cachedSettingsUrl = null;
}
(async () => {
  try {
    const { getSettings } = await import("@/lib/db/settings");
    const settings = await getSettings();
    if (typeof settings.cliproxyapi_url === "string" && settings.cliproxyapi_url.trim()) {
      _cachedSettingsUrl = { url: settings.cliproxyapi_url.trim(), ts: Date.now() };
    }
  } catch {
  }
})();
async function resolveCliproxyapiBaseUrl() {
  if (_cachedSettingsUrl && Date.now() - _cachedSettingsUrl.ts < URL_CACHE_TTL_MS) {
    return _cachedSettingsUrl.url;
  }
  try {
    const { getSettings } = await import("@/lib/db/settings");
    const settings = await getSettings();
    if (typeof settings.cliproxyapi_url === "string" && settings.cliproxyapi_url.trim()) {
      const url2 = settings.cliproxyapi_url.trim();
      _cachedSettingsUrl = { url: url2, ts: Date.now() };
      return url2;
    }
  } catch {
  }
  const host = process.env.CLIPROXYAPI_HOST || DEFAULT_HOST;
  const port = parseInt(process.env.CLIPROXYAPI_PORT || String(DEFAULT_PORT), 10);
  const url = `http://${host}:${port}`;
  _cachedSettingsUrl = { url, ts: Date.now() };
  return url;
}
function resolveCliproxyapiBaseUrlSync() {
  if (_cachedSettingsUrl && Date.now() - _cachedSettingsUrl.ts < URL_CACHE_TTL_MS) {
    return _cachedSettingsUrl.url;
  }
  const host = process.env.CLIPROXYAPI_HOST || DEFAULT_HOST;
  const port = parseInt(process.env.CLIPROXYAPI_PORT || String(DEFAULT_PORT), 10);
  return `http://${host}:${port}`;
}
function isCliproxyapiDeepModeEnabled(providerSpecificData) {
  return providerSpecificData?.cliproxyapiMode === "claude-native";
}
class CliproxyapiExecutor extends BaseExecutor {
  upstreamBaseUrl;
  constructor(baseUrl) {
    const effectiveBase = baseUrl ?? resolveCliproxyapiBaseUrlSync();
    super("cliproxyapi", {
      id: "cliproxyapi",
      baseUrl: effectiveBase + "/v1/chat/completions",
      headers: { "Content-Type": "application/json" }
    });
    this.upstreamBaseUrl = effectiveBase;
  }
  buildUrl(_model, _stream, _urlIndex = 0, _credentials = null) {
    return `${this.upstreamBaseUrl}/v1/chat/completions`;
  }
  /**
   * Returns true when the body matches the Anthropic Messages wire shape.
   *
   * chatCore detects target=claude when the request comes from a Claude-source
   * client (`/v1/messages`, Anthropic-version header, claude/* model). In that
   * case no openai translation is applied and the executor sees the original
   * Anthropic body: top-level `system` as an array of content blocks, and
   * `messages[].content` as arrays. Routing those bodies to CPA's
   * /v1/chat/completions causes CPA to emit OpenAI-style SSE chunks, which
   * Anthropic SDK clients (Capy, claude-cli, etc.) cannot parse — the result
   * looks like a 200 server-side with "0 chunks received" client-side.
   *
   * CPA exposes /v1/messages natively (claude executor with uTLS spoof,
   * billing header, CCH signing, etc.) and emits proper Anthropic SSE:
   * `event: message_start`, `content_block_delta`, etc.
   */
  isAnthropicShape(body) {
    if (!body || typeof body !== "object") return false;
    const b = body;
    if (b.system !== void 0) return true;
    if (b.thinking !== void 0) return true;
    if (b.metadata && typeof b.metadata === "object" && b.metadata.user_id !== void 0)
      return true;
    const msgs = b.messages;
    if (Array.isArray(msgs) && msgs.length > 0) {
      const first = msgs[0];
      if (Array.isArray(first?.content)) return true;
    }
    return false;
  }
  selectEndpoint(body) {
    return this.isAnthropicShape(body) ? "/v1/messages" : "/v1/chat/completions";
  }
  buildHeaders(credentials, stream = true) {
    const key = credentials?.apiKey || credentials?.accessToken;
    const headers = {
      "Content-Type": "application/json",
      ...getProviderPluginManifestHeader()
    };
    if (key) {
      headers["Authorization"] = `Bearer ${key}`;
    }
    if (stream) {
      headers["Accept"] = "text/event-stream";
    }
    return headers;
  }
  transformRequest(model, body, _stream, _credentials) {
    if (!body || typeof body !== "object") return body;
    const transformed = { ...body };
    if (transformed.model !== model) {
      transformed.model = model;
    }
    if (this.isAnthropicShape(transformed)) {
      delete transformed.output_config;
      delete transformed.context_management;
      delete transformed.client_info;
      delete transformed.prompt_cache_key;
      delete transformed.safety_identifier;
      delete transformed.metadata;
      const thinking = transformed.thinking;
      if (thinking && typeof thinking === "object") {
        const t = thinking;
        const validType = t.type === "enabled" || t.type === "disabled";
        const hasValidBudget = typeof t.budget_tokens === "number" && t.budget_tokens >= 0;
        const hasInvalidExtras = "display" in t;
        if (!validType || !hasValidBudget || hasInvalidExtras) {
          delete transformed.thinking;
        }
      }
      if (Array.isArray(transformed.tools)) {
        transformed.tools = sanitizeClaudeToolSchemas(transformed.tools);
      }
      const cloakMap = cloakThirdPartyToolNames(transformed, {
        skip: (name) => MCP_RESERVED_PREFIX_RE.test(name)
      });
      const mcpMap = applyMcpToolNameRewrite(transformed);
      const toolNameMap = new Map(cloakMap);
      for (const [alias, original] of mcpMap) {
        toolNameMap.set(alias, original);
      }
      if (toolNameMap.size > 0) {
        Object.defineProperty(transformed, "_toolNameMap", {
          value: toolNameMap,
          enumerable: false,
          configurable: true,
          writable: true
        });
      }
    }
    return transformed;
  }
  async execute(input) {
    const baseUrl = await resolveCliproxyapiBaseUrl();
    const endpoint = this.selectEndpoint(input.body);
    const url = `${baseUrl}${endpoint}`;
    const shape = endpoint === "/v1/messages" ? "anthropic" : "openai";
    const headers = this.buildHeaders(input.credentials, input.stream);
    const transformedBody = this.transformRequest(
      input.model,
      input.body,
      input.stream,
      input.credentials
    );
    mergeUpstreamExtraHeaders(headers, input.upstreamExtraHeaders);
    const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const combinedSignal = input.signal ? mergeAbortSignals(input.signal, timeoutSignal) : timeoutSignal;
    input.log?.info?.("CPA", `CLIProxyAPI \u2192 ${url} (model: ${input.model}, shape: ${shape})`);
    const wireBody = transformedBody && typeof transformedBody === "object" ? JSON.stringify(
      transformedBody,
      (key, value) => key === "_toolNameMap" ? void 0 : value
    ) : JSON.stringify(transformedBody);
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: wireBody,
      signal: combinedSignal
    });
    if (response.status === HTTP_STATUS.RATE_LIMITED) {
      input.log?.warn?.("CPA", `CLIProxyAPI rate limited: ${response.status}`);
    }
    return { response, url, headers, transformedBody };
  }
  /**
   * Health check — verifies CLIProxyAPI is reachable.
   *
   * CPA 6.x doesn't expose a /health endpoint; previously we hit /health
   * and got 404, which made the dashboard report "CLIProxyAPI not
   * detected" even when the service was up and successfully serving
   * /v1/messages. Probe /v1/models instead (returns 200 with the
   * advertised model list), which is the closest thing CPA has to a
   * liveness probe and works on every CPA version we've tested.
   */
  async healthCheck() {
    const start = Date.now();
    try {
      const baseUrl = await resolveCliproxyapiBaseUrl();
      const res = await fetch(`${baseUrl}/v1/models`, {
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS)
      });
      return {
        ok: res.ok,
        latencyMs: Date.now() - start,
        ...!res.ok ? { error: `HTTP ${res.status}` } : {}
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }
}
var cliproxyapi_default = CliproxyapiExecutor;
export {
  CliproxyapiExecutor,
  clearCliproxyapiUrlCache,
  cliproxyapi_default as default,
  isCliproxyapiDeepModeEnabled,
  resolveCliproxyapiBaseUrl
};
