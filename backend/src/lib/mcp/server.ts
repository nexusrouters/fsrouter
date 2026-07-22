/**
 * FSRouter MCP Server
 * Exposes FSRouter capabilities (model catalog, provider list, chat routing,
 * health) to AI agents over MCP (Streamable HTTP + SSE transports).
 *
 * Ported/adapted from OmniRoute v3.8.49 open-sse/mcp-server, trimmed to the
 * surface FSRouter actually provides (no combos / audit-db / scope-enforcement
 * modules exist here yet). Uses the high-level McpServer.registerTool() API.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// FSRouter internals
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";

let cachedServer: McpServer | null = null;

function listAllModels(): { provider: string; id: string; name: string }[] {
  const out: { provider: string; id: string; name: string }[] = [];
  for (const [provider, models] of Object.entries(PROVIDER_MODELS)) {
    for (const m of models || []) {
      out.push({ provider, id: m.id, name: m.name || m.id });
    }
  }
  return out;
}

function listProviders(): { id: string; name: string }[] {
  return Object.values(PROVIDERS).map((p: any) => ({
    id: p.id || p.alias,
    name: p.display?.name || p.name || p.alias || p.id,
  }));
}

async function resolveApiKey(provider: string): Promise<string | null> {
  try {
    const resp = await fetch(`http://127.0.0.1:20128/api/providers?provider=${encodeURIComponent(provider)}`, {
      headers: { "Content-Type": "application/json" },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const conns = data?.connections || [];
    const active =
      conns.find((c: any) => (c.isActive || c.active) && c.apiKey) ||
      conns.find((c: any) => c.apiKey);
    return active?.apiKey || null;
  } catch {
    return null;
  }
}

export function createMcpServer(): McpServer {
  // Fresh server per request — SDK forbids connecting one McpServer instance
  // to more than one transport (stateless HTTP receives concurrent requests).
  const server = new McpServer({
    name: "fsrouter-mcp",
    version: "0.6.171",
  });

  // ── health ──────────────────────────────────────────────────────────────
  server.registerTool(
    "health",
    {
      title: "FSRouter Health",
      description: "Return FSRouter server health and loaded provider/model counts.",
      inputSchema: {},
    },
    async () => {
      const models = listAllModels();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                providers: listProviders().length,
                models: models.length,
                uptime: process.uptime(),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ── list_providers ────────────────────────────────────────────────────────
  server.registerTool(
    "list_providers",
    {
      title: "List Providers",
      description: "List all configured AI providers known to FSRouter.",
      inputSchema: {},
    },
    async () => {
      return {
        content: [{ type: "text", text: JSON.stringify(listProviders(), null, 2) }],
      };
    },
  );

  // ── list_models ────────────────────────────────────────────────────────────
  server.registerTool(
    "list_models",
    {
      title: "List Models",
      description: "List models, optionally filtered by provider.",
      inputSchema: {
        provider: z.string().optional().describe("Provider id/alias to filter by"),
      },
    },
    async ({ provider }) => {
      let models = listAllModels();
      if (provider) models = models.filter((m) => m.provider === provider);
      return {
        content: [{ type: "text", text: JSON.stringify(models.slice(0, 500), null, 2) }],
      };
    },
  );

  // ── route_request ──────────────────────────────────────────────────────────
  server.registerTool(
    "route_request",
    {
      title: "Route Chat Request",
      description:
        "Send a chat completion through FSRouter (provider/model resolved automatically). Requires a saved connection/apiKey for the provider.",
      inputSchema: {
        model: z.string().describe("Model id, e.g. 'openai/gpt-4o' or 'claude-sonnet-4-5'"),
        messages: z
          .array(
            z.object({
              role: z.string(),
              content: z.string(),
            }),
          )
          .describe("Chat messages"),
        provider: z.string().optional().describe("Force a specific provider"),
        stream: z.boolean().optional().default(false).describe("Stream response"),
      },
    },
    async ({ model, messages, provider, stream }) => {
      const target = provider ? `${provider}/${model}` : model;
      const apiKey = await resolveApiKey(provider || model.split("/")[0]);
      const body = { model: target, messages, stream: false };
      try {
        const resp = await fetch("http://127.0.0.1:20128/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify(body),
        });
        if (!resp.ok) {
          const err = await resp.text();
          return {
            content: [{ type: "text", text: `ERROR ${resp.status}: ${err}` }],
            isError: true,
          };
        }
        const data: any = await resp.json();
        const text =
          data?.choices?.[0]?.message?.content ||
          data?.choices?.[0]?.text ||
          JSON.stringify(data);
        return { content: [{ type: "text", text }] };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `ERROR: ${e?.message || String(e)}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}
