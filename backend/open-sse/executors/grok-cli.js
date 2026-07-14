/**
 * Grok CLI Executor — uses xAI API (api.x.ai) with token from ~/.grok/auth.json.
 * Auth: reads OIDC token from ~/.grok/auth.json (set by `grok login`).
 * OpenAI-compatible format.
 * 
 * NOTE: Requires xAI credits or Grok subscription.
 * Free Grok 4.5 is only available via the Grok CLI TUI, not via API.
 */

import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const XAI_API = "https://api.x.ai/v1/chat/completions";
const AUTH_JSON_PATH = join(homedir(), ".grok", "auth.json");

function readCliToken() {
  try {
    const raw = readFileSync(AUTH_JSON_PATH, "utf-8");
    const data = JSON.parse(raw);
    for (const [_scope, entry] of Object.entries(data)) {
      if (entry && typeof entry === "object" && entry.key) {
        return entry.key;
      }
    }
    return data.session_token || data.token || data.access_token || data.key || null;
  } catch {
    return null;
  }
}

export class GrokCliExecutor extends BaseExecutor {
  constructor() {
    super("grok-cli", PROVIDERS["grok-cli"]);
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    let token = credentials?.apiKey || readCliToken();
    if (!token || token === "cli-auth") {
      token = readCliToken();
    }
    if (!token) {
      return {
        response: new Response(JSON.stringify({
          error: {
            message: "Grok CLI not authenticated. Run `grok login` on the server, or paste xAI API key.",
            type: "authentication_error",
          },
        }), { status: 401, headers: { "Content-Type": "application/json" } }),
        url: XAI_API,
        headers: {},
        transformedBody: body,
      };
    }

    if (token.startsWith("Bearer ")) token = token.slice(7);

    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    };

    // Map grok-4.5 to actual xAI model ID
    const MODEL_MAP = {
      "grok-4.5": "grok-4-0709",
      "grok-4": "grok-4-0709",
      "grok-3": "grok-3",
    };

    const upstreamModel = MODEL_MAP[model] || model;
    const upstreamBody = { ...body, model: upstreamModel, stream: stream !== false };

    log?.info?.("GROK-CLI", `→ ${model} (upstream: ${upstreamModel}) via api.x.ai`);

    let response;
    try {
      response = await fetch(XAI_API, {
        method: "POST",
        headers,
        body: JSON.stringify(upstreamBody),
        signal,
      });
    } catch (err) {
      log?.error?.("GROK-CLI", `Fetch failed: ${err.message}`);
      return {
        response: new Response(JSON.stringify({
          error: { message: `Grok connection failed: ${err.message}`, type: "upstream_error" },
        }), { status: 502, headers: { "Content-Type": "application/json" } }),
        url: XAI_API,
        headers,
        transformedBody: upstreamBody,
      };
    }

    if (!response.ok) {
      const status = response.status;
      const errBody = await response.text().catch(() => "");
      let errMsg;
      if (status === 401) errMsg = "Grok token expired. Run `grok login` to refresh, or paste a new xAI API key.";
      else if (status === 429) errMsg = "Grok rate limited. Wait and retry.";
      else if (errBody.includes("spending-limit")) errMsg = "No xAI credits. Add credits at https://console.x.ai or use Grok subscription.";
      else errMsg = `Grok returned HTTP ${status}: ${errBody.slice(0, 200)}`;
      log?.warn?.("GROK-CLI", errMsg);
      return {
        response: new Response(JSON.stringify({
          error: { message: errMsg, type: "upstream_error", code: `HTTP_${status}` },
        }), { status: status === 403 ? 402 : status, headers: { "Content-Type": "application/json" } }),
        url: XAI_API,
        headers,
        transformedBody: upstreamBody,
      };
    }

    // Pass through — xAI API is OpenAI-compatible
    return { response, url: XAI_API, headers, transformedBody: upstreamBody };
  }
}
