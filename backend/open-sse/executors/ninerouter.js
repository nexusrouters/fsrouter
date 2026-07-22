import {
  BaseExecutor,
  mergeUpstreamExtraHeaders,
  mergeAbortSignals
} from "./base.ts";
import { FETCH_TIMEOUT_MS } from "../config/constants.ts";
import { buildErrorBody } from "../utils/error.js";
import { getSupervisor } from '../../lib/services/registry.js';
import { getOrCreateApiKey } from '../../lib/services/apiKey.js';
const DEFAULT_PORT = 20130;
const DEFAULT_HOST = "127.0.0.1";
const HEALTH_CHECK_TIMEOUT_MS = 3e3;
const NINEROUTER_FALLBACK_HINT = "connection_cooldown";
const NINEROUTER_FALLBACK_HINT_HEADER = "X-Omni-Fallback-Hint";
function resolveNineRouterBaseUrl() {
  const host = process.env.NINEROUTER_HOST || DEFAULT_HOST;
  const port = parseInt(process.env.NINEROUTER_PORT || String(DEFAULT_PORT), 10);
  return `http://${host}:${port}`;
}
class NineRouterExecutor extends BaseExecutor {
  upstreamBaseUrl;
  constructor(baseUrl) {
    const effectiveBase = baseUrl ?? resolveNineRouterBaseUrl();
    super("9router", {
      id: "9router",
      baseUrl: `${effectiveBase}/v1/chat/completions`,
      headers: { "Content-Type": "application/json" }
    });
    this.upstreamBaseUrl = effectiveBase;
  }
  buildUrl(_model, _stream, _urlIndex = 0, _credentials = null) {
    return `${this.upstreamBaseUrl}/v1/chat/completions`;
  }
  /**
   * Build a 503 service_not_running Response with the fallback hint header.
   * Message goes through buildErrorBody to satisfy hard rule #12 (no raw err.message).
   */
  buildServiceUnavailableResponse(message) {
    const body = buildErrorBody(503, message);
    body.error.code = "service_not_running";
    return new Response(JSON.stringify(body), {
      status: 503,
      headers: {
        "Content-Type": "application/json",
        [NINEROUTER_FALLBACK_HINT_HEADER]: NINEROUTER_FALLBACK_HINT
      }
    });
  }
  /**
   * True when the body matches the Anthropic Messages wire shape.
   * The same heuristic used by CliproxyapiExecutor — see comments there for
   * the reasoning behind each signal.
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
    const key = credentials?.apiKey ?? credentials?.accessToken;
    const headers = { "Content-Type": "application/json" };
    if (key) headers["Authorization"] = `Bearer ${key}`;
    if (stream) headers["Accept"] = "text/event-stream";
    return headers;
  }
  transformRequest(model, body, _stream, _credentials) {
    if (!body || typeof body !== "object") return body;
    const transformed = { ...body };
    if (transformed.model !== model) transformed.model = model;
    return transformed;
  }
  async execute(input) {
    const supervisor = getSupervisor("9router");
    const status = supervisor?.getStatus();
    if (!supervisor || status?.state !== "running") {
      const stateLabel = status?.state ?? "unknown";
      const msg = `9router is not running (state: ${stateLabel})`;
      input.log?.warn?.("9ROUTER", msg);
      return {
        response: this.buildServiceUnavailableResponse(msg),
        url: "",
        headers: {},
        transformedBody: null
      };
    }
    const dynamicPort = status.port;
    const dynamicBaseUrl = `http://127.0.0.1:${dynamicPort}`;
    const apiKey = await getOrCreateApiKey("9router");
    const dynamicCredentials = { ...input.credentials, apiKey };
    const innerModel = input.model.replace(/^9router\//, "");
    const endpoint = this.selectEndpoint(input.body);
    const url = `${dynamicBaseUrl}${endpoint}`;
    const shape = endpoint === "/v1/messages" ? "anthropic" : "openai";
    const headers = this.buildHeaders(dynamicCredentials, input.stream);
    const transformedBody = this.transformRequest(
      innerModel,
      input.body,
      input.stream,
      dynamicCredentials
    );
    mergeUpstreamExtraHeaders(headers, input.upstreamExtraHeaders ?? null);
    const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const combinedSignal = input.signal ? mergeAbortSignals(input.signal, timeoutSignal) : timeoutSignal;
    input.log?.info?.(
      "9ROUTER",
      `\u2192 ${url} (model: ${innerModel}, shape: ${shape}, port: ${dynamicPort})`
    );
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(transformedBody),
      signal: combinedSignal
    });
    return { response, url, headers, transformedBody };
  }
  async healthCheck() {
    const start = Date.now();
    try {
      const res = await fetch(`${this.upstreamBaseUrl}/api/health`, {
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
var ninerouter_default = NineRouterExecutor;
export {
  NINEROUTER_FALLBACK_HINT,
  NINEROUTER_FALLBACK_HINT_HEADER,
  NineRouterExecutor,
  ninerouter_default as default,
  resolveNineRouterBaseUrl
};
