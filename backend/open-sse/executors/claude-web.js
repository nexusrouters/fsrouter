import { BaseExecutor, mergeAbortSignals } from "./base.ts";
import { FETCH_TIMEOUT_MS } from "../config/constants.ts";
import { tlsFetchClaude } from "../services/claudeTlsClient.ts";
import { getCfClearanceToken } from "../services/claudeTurnstileSolver.ts";
import { normalizeSessionCookieHeader } from "@/lib/providers/webCookieAuth";
import { randomUUID } from "crypto";
import { sanitizeErrorMessage } from "../utils/error.ts";
import { tryBackedChat } from "../services/browserBackedChat.ts";
import {
  transformToClaude,
  transformFromClaude
} from "./claude-web/payload.ts";
const CLAUDE_WEB_API_BASE = "https://claude.ai/api";
const CLAUDE_WEB_ORGS_URL = `${CLAUDE_WEB_API_BASE}/organizations`;
const CLAUDE_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const CLAUDE_SESSION_COOKIE_NAME = "sessionKey";
function readClaudeWebCookie(credentials) {
  if (!credentials || typeof credentials !== "object") return "";
  const c = credentials;
  const direct = typeof c.cookie === "string" ? c.cookie : "";
  if (direct.trim()) return direct;
  const apiKey = typeof c.apiKey === "string" ? c.apiKey : "";
  if (apiKey.trim()) return apiKey;
  const psd = c.providerSpecificData;
  if (psd && typeof psd === "object") {
    const nested = psd.cookie;
    if (typeof nested === "string" && nested.trim()) return nested;
  }
  return "";
}
function readClaudeWebDeviceId(credentials) {
  if (!credentials || typeof credentials !== "object") return void 0;
  const c = credentials;
  if (typeof c.deviceId === "string" && c.deviceId.trim()) return c.deviceId;
  const psd = c.providerSpecificData;
  if (psd && typeof psd === "object") {
    const nested = psd.deviceId;
    if (typeof nested === "string" && nested.trim()) return nested;
  }
  return void 0;
}
function getBrowserHeaders(deviceId) {
  const headers = {
    Accept: "text/event-stream",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Content-Type": "application/json",
    Origin: "https://claude.ai",
    Pragma: "no-cache",
    Priority: "u=1, i",
    Referer: "https://claude.ai/new",
    "Sec-Ch-Ua": '"Chromium";v="149", "Not-A.Brand";v="24", "Google Chrome";v="149"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Linux"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "User-Agent": CLAUDE_USER_AGENT,
    // Anthropic-specific headers
    "anthropic-client-platform": "web_claude_ai"
  };
  if (deviceId) {
    headers["anthropic-device-id"] = deviceId;
  }
  return headers;
}
function normalizeClaudeSessionCookie(rawValue) {
  return normalizeSessionCookieHeader(rawValue, CLAUDE_SESSION_COOKIE_NAME);
}
async function normalizeClaudeSessionCookieWithAutoRefresh(rawValue, options) {
  let normalized = normalizeClaudeSessionCookie(rawValue);
  if (normalized.includes("cf_clearance=")) {
    return normalized;
  }
  if (options?.allowAutoSolve !== false) {
    try {
      options?.log?.info?.("CLAUDE-WEB", "cf_clearance missing, attempting to solve Turnstile...");
      const cfClearance = await getCfClearanceToken();
      const cfCookie = `cf_clearance=${cfClearance}`;
      normalized = normalized ? `${normalized}; ${cfCookie}` : cfCookie;
      options?.log?.info?.("CLAUDE-WEB", "cf_clearance injected successfully");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options?.log?.warn?.("CLAUDE-WEB", `cf_clearance injection failed: ${message}`);
    }
  }
  return normalized;
}
async function verifyCookieValidity(cookieHeader, deviceId, signal) {
  try {
    const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const combinedSignal = signal ? mergeAbortSignals(signal, timeoutSignal) : timeoutSignal;
    const response = await tlsFetchClaude(CLAUDE_WEB_ORGS_URL, {
      method: "GET",
      headers: {
        ...getBrowserHeaders(deviceId),
        Cookie: cookieHeader
      },
      timeoutMs: FETCH_TIMEOUT_MS,
      signal: combinedSignal
    });
    return response.status === 200;
  } catch (error) {
    return false;
  }
}
async function getOrganizationId(cookieHeader, deviceId, signal) {
  try {
    const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const combinedSignal = signal ? mergeAbortSignals(signal, timeoutSignal) : timeoutSignal;
    const response = await tlsFetchClaude(CLAUDE_WEB_ORGS_URL, {
      method: "GET",
      headers: {
        ...getBrowserHeaders(deviceId),
        Cookie: cookieHeader
      },
      timeoutMs: FETCH_TIMEOUT_MS,
      signal: combinedSignal
    });
    if (response.status !== 200) {
      return null;
    }
    const data = JSON.parse(response.text ?? "[]");
    return data?.[0]?.uuid || data?.[0]?.id || null;
  } catch (error) {
    return null;
  }
}
function shouldUseBrowserBacked() {
  const flag = process.env.WEB_COOKIE_USE_BROWSER;
  if (flag === "1" || flag === "true" || flag === "on") return true;
  const poolFlag = process.env.OMNIROUTE_BROWSER_POOL;
  return poolFlag === "on" || poolFlag === "1" || poolFlag === "true";
}
function extractLastUserText(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const content = messages[i].content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content.map((c) => typeof c === "object" && c && "text" in c ? String(c.text) : "").filter(Boolean).join("\n");
      }
    }
  }
  return "Reply with OK";
}
async function buildClaudeStreamingResponse(upstreamResp, model, log, tlsBody) {
  const src = tlsBody ?? upstreamResp.body;
  if (!src) {
    return new Response(
      JSON.stringify({
        error: {
          message: "No upstream response body available",
          type: "upstream_error"
        }
      }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }
  let finished = false;
  const transformed = new ReadableStream({
    async start(controller) {
      const reader = src.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;
            const jsonStr = trimmed.slice(6);
            try {
              const parsed = JSON.parse(jsonStr);
              if (parsed.type === "content_block_delta") {
                const delta = parsed.delta;
                const text = delta?.text;
                if (text) {
                  const chunk = transformFromClaude(text, model);
                  const out = `data: ${JSON.stringify(chunk)}

`;
                  controller.enqueue(new TextEncoder().encode(out));
                }
              } else if (parsed.type === "message_stop") {
                const chunk = transformFromClaude("", model, "end_turn");
                const out = `data: ${JSON.stringify(chunk)}

`;
                controller.enqueue(new TextEncoder().encode(out));
                finished = true;
              } else if (parsed.type === "message_delta") {
                const delta = parsed.delta;
                const stopReason = delta?.stop_reason;
                if (stopReason) {
                  const chunk = transformFromClaude("", model, stopReason);
                  const out = `data: ${JSON.stringify(chunk)}

`;
                  controller.enqueue(new TextEncoder().encode(out));
                }
              }
            } catch {
            }
          }
        }
        if (buffer.trim()) {
          const trimmed = buffer.trim();
          if (trimmed.startsWith("data: ")) {
            const jsonStr = trimmed.slice(6);
            try {
              const parsed = JSON.parse(jsonStr);
              if (parsed.type === "content_block_delta") {
                const delta = parsed.delta;
                const text = delta?.text;
                if (text) {
                  const chunk = transformFromClaude(text, model);
                  controller.enqueue(
                    new TextEncoder().encode(`data: ${JSON.stringify(chunk)}

`)
                  );
                }
              }
            } catch {
            }
          }
        }
        if (!finished) {
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        }
      } catch (err) {
        log?.error?.("CLAUDE-WEB-STREAM", `Stream error: ${String(err)}`);
        controller.error(err);
      } finally {
        try {
          reader.releaseLock();
        } catch {
        }
        try {
          controller.close();
        } catch {
        }
      }
    }
  });
  return new Response(transformed, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    }
  });
}
class ClaudeWebExecutor extends BaseExecutor {
  constructor() {
    super("claude-web", {
      baseUrl: CLAUDE_WEB_API_BASE
    });
  }
  /**
   * Test connection to Claude Web API
   */
  async testConnection(credentials, signal) {
    try {
      const rawCookie = readClaudeWebCookie(credentials);
      if (!rawCookie.trim()) {
        return false;
      }
      const cookieHeader = await normalizeClaudeSessionCookieWithAutoRefresh(rawCookie, {
        allowAutoSolve: false
      });
      const deviceId = readClaudeWebDeviceId(credentials);
      return await verifyCookieValidity(cookieHeader, deviceId, signal);
    } catch (error) {
      return false;
    }
  }
  /**
   * Get user's organization ID from session
   */
  async execute({ model, body, stream: _stream, credentials, signal, log }) {
    const bodyObj = body || {};
    try {
      if (!credentials || typeof credentials !== "object") {
        const errorResp = new Response(
          JSON.stringify({
            error: {
              message: "Invalid credentials",
              type: "invalid_request_error"
            }
          }),
          {
            status: 400,
            statusText: "Bad Request",
            headers: { "Content-Type": "application/json" }
          }
        );
        return {
          response: errorResp,
          url: "",
          headers: {},
          transformedBody: bodyObj
        };
      }
      const rawCookie = readClaudeWebCookie(credentials);
      if (!rawCookie.trim()) {
        const errorResp = new Response(
          JSON.stringify({
            error: {
              message: "Missing session cookie",
              type: "authentication_error"
            }
          }),
          {
            status: 401,
            statusText: "Unauthorized",
            headers: { "Content-Type": "application/json" }
          }
        );
        return {
          response: errorResp,
          url: "",
          headers: {},
          transformedBody: bodyObj
        };
      }
      const cookieHeader = await normalizeClaudeSessionCookieWithAutoRefresh(rawCookie, {
        allowAutoSolve: true,
        log
      });
      const deviceId = readClaudeWebDeviceId(credentials);
      let claudePayload;
      try {
        claudePayload = transformToClaude(bodyObj, model);
      } catch (transformError) {
        const errorResp = new Response(
          JSON.stringify({
            error: {
              message: transformError instanceof Error ? transformError.message : "Invalid request format",
              type: "invalid_request_error"
            }
          }),
          {
            status: 400,
            statusText: "Bad Request",
            headers: { "Content-Type": "application/json" }
          }
        );
        return {
          response: errorResp,
          url: "",
          headers: {},
          transformedBody: bodyObj
        };
      }
      let orgId = credentials?.orgId;
      let conversationId = credentials?.conversationId;
      if (!orgId) {
        orgId = await getOrganizationId(cookieHeader, deviceId, signal);
        if (!orgId) {
          log?.warn?.("CLAUDE-WEB", "Could not retrieve organization ID, using fallback");
          orgId = "";
        }
      }
      if (!conversationId) {
        conversationId = randomUUID();
      }
      const headers = getBrowserHeaders(deviceId);
      if (shouldUseBrowserBacked()) {
        const userText = extractLastUserText(bodyObj);
        const completionUrl2 = orgId ? `${CLAUDE_WEB_API_BASE}/organizations/${orgId}/chat_conversations/PLACEHOLDER/completion` : `${CLAUDE_WEB_API_BASE}/chat_conversations/PLACEHOLDER/completion`;
        const result = await tryBackedChat({
          poolKey: "claude-web",
          chatPageUrl: "https://claude.ai/new",
          chatUrl: completionUrl2,
          chatUrlMatchDomain: "claude.ai",
          cookieString: rawCookie,
          cookieDomain: ".claude.ai",
          userMessage: userText,
          inputSelector: "div[contenteditable='true']",
          postSubmitWaitMs: 15e3,
          signal: signal ?? null
        });
        if (result.status > 0) {
          const upstreamResp = new Response(result.body, {
            status: result.status,
            headers: {
              "Content-Type": result.contentType || "text/event-stream"
            }
          });
          return {
            response: await buildClaudeStreamingResponse(upstreamResp, model, log, null),
            url: completionUrl2,
            headers,
            transformedBody: claudePayload
          };
        }
        const errorResp = new Response(
          JSON.stringify({
            error: {
              message: `Claude Web browser-backed chat captured no upstream response (timing: ${JSON.stringify(
                result.timing
              )})`,
              type: "upstream_error"
            }
          }),
          {
            status: 502,
            headers: { "Content-Type": "application/json" }
          }
        );
        return {
          response: errorResp,
          url: completionUrl2,
          headers,
          transformedBody: claudePayload
        };
      }
      const completionUrl = orgId && conversationId ? `${CLAUDE_WEB_API_BASE}/organizations/${orgId}/chat_conversations/${conversationId}/completion` : `${CLAUDE_WEB_API_BASE}/chat_conversations/new/completion`;
      const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
      const combinedSignal = signal ? mergeAbortSignals(signal, timeoutSignal) : timeoutSignal;
      log?.debug?.("CLAUDE-WEB", `Making request to ${completionUrl}`);
      const fetchResponse = await tlsFetchClaude(completionUrl, {
        method: "POST",
        headers: {
          ...headers,
          Cookie: cookieHeader
        },
        body: JSON.stringify(claudePayload),
        timeoutMs: FETCH_TIMEOUT_MS,
        stream: true,
        signal: combinedSignal
      });
      if (fetchResponse.status < 200 || fetchResponse.status >= 300) {
        log?.error?.("CLAUDE-WEB", `HTTP ${fetchResponse.status}`);
        if (fetchResponse.status === 401) {
          const errorResp2 = new Response(
            JSON.stringify({
              error: {
                message: "Session expired or invalid",
                type: "authentication_error"
              }
            }),
            {
              status: 401,
              statusText: "Unauthorized",
              headers: { "Content-Type": "application/json" }
            }
          );
          return {
            response: errorResp2,
            url: completionUrl,
            headers,
            transformedBody: claudePayload
          };
        }
        if (fetchResponse.status === 429) {
          const errorResp2 = new Response(
            JSON.stringify({
              error: {
                message: "Rate limited by Claude Web API",
                type: "rate_limit_error"
              }
            }),
            {
              status: 429,
              statusText: "Too Many Requests",
              headers: { "Content-Type": "application/json" }
            }
          );
          return {
            response: errorResp2,
            url: completionUrl,
            headers,
            transformedBody: claudePayload
          };
        }
        let errorText = "";
        let cfMitigated = null;
        try {
          if (fetchResponse.body) {
            const reader = fetchResponse.body.getReader();
            const decoder = new TextDecoder();
            const chunks = [];
            let total = 0;
            const maxBytes = 2048;
            while (total < maxBytes) {
              const { value, done } = await reader.read();
              if (done || !value) break;
              chunks.push(value);
              total += value.byteLength;
            }
            try {
              reader.releaseLock();
            } catch {
            }
            if (chunks.length === 1) {
              errorText = decoder.decode(chunks[0]);
            } else {
              const combined = new Uint8Array(total);
              let offset = 0;
              for (const chunk of chunks) {
                combined.set(chunk, offset);
                offset += chunk.byteLength;
              }
              errorText = decoder.decode(combined);
            }
          } else if (fetchResponse.text) {
            errorText = fetchResponse.text;
          }
        } catch {
          errorText = "";
        }
        cfMitigated = fetchResponse.headers.get("cf-mitigated");
        const isCloudflareChallenge = fetchResponse.status === 403 && (cfMitigated === "challenge" || /<title>\s*Just a moment/i.test(errorText) || /<title>\s*Attention Required/i.test(errorText));
        let errorMessage;
        if (isCloudflareChallenge) {
          errorMessage = `Claude Web returned a Cloudflare bot-management challenge (cf-mitigated=${cfMitigated ?? "challenge"}). The sandbox / VPS IP appears to be flagged; the cf_clearance cookie pasted from a residential IP won't pass. Probe from a residential network, or use the official Anthropic API (provider: 'claude') instead.`;
        } else {
          const trimmed = errorText.trim().slice(0, 500);
          errorMessage = trimmed ? `Claude Web API error (${fetchResponse.status}): ${trimmed}` : `Claude Web API error (${fetchResponse.status}) with no response body`;
        }
        const errorResp = new Response(
          JSON.stringify({
            error: {
              message: errorMessage,
              type: isCloudflareChallenge ? "cloudflare_challenge" : "api_error",
              code: isCloudflareChallenge ? "cf_mitigated_challenge" : `HTTP_${fetchResponse.status}`,
              ...cfMitigated ? { cfMitigated } : {}
            }
          }),
          {
            status: fetchResponse.status,
            statusText: "HTTP Error",
            headers: { "Content-Type": "application/json" }
          }
        );
        return {
          response: errorResp,
          url: completionUrl,
          headers,
          transformedBody: claudePayload
        };
      }
      return {
        response: await buildClaudeStreamingResponse(fetchResponse, model, log, fetchResponse.body),
        url: completionUrl,
        headers,
        transformedBody: claudePayload
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log?.error?.("CLAUDE-WEB", `Fetch failed: ${errorMessage}`);
      const errorResp = new Response(
        JSON.stringify({
          error: {
            message: `Claude Web connection failed: ${sanitizeErrorMessage(errorMessage)}`,
            type: "api_connection_error"
          }
        }),
        {
          status: 500,
          statusText: "Internal Server Error",
          headers: { "Content-Type": "application/json" }
        }
      );
      return {
        response: errorResp,
        url: "",
        headers: {},
        transformedBody: bodyObj
      };
    }
  }
}
export {
  ClaudeWebExecutor
};
