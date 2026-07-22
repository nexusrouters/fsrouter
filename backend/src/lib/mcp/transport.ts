/**
 * FSRouter MCP — Express-compatible HTTP transports.
 * Adapted from OmniRoute v3.8.49 open-sse/mcp-server/httpTransport.ts,
 * rewritten for Express (FSRouter) instead of Next.js Response objects.
 *
 * Stateful sessions: one McpServer instance per MCP sessionId, so initialize
 * (req 1) and tools/list / tools/call (req 2+) share the same server.
 */
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import { createMcpServer } from "./server.js";

const sseTransports = new Map<string, SSEServerTransport>();
// sessionId -> { server, transport } for Streamable HTTP
const streamSessions = new Map<string, { server: any; transport: StreamableHTTPServerTransport }>();

/** GET /api/mcp/sse — SSE handshake + stream. */
export async function handleMcpSSE(req: any, res: any) {
  const server = createMcpServer();
  const transport = new SSEServerTransport("/api/mcp/message", res);
  sseTransports.set(transport.sessionId, transport);
  res.on("close", () => {
    sseTransports.delete(transport.sessionId);
  });
  await server.connect(transport);
}

/** POST /api/mcp/message — SSE client → server messages. */
export async function handleMcpMessage(req: any, res: any) {
  const sessionId = req.query.sessionId as string;
  const transport = sseTransports.get(sessionId);
  if (!transport) {
    res.status(404).json({ error: "Unknown MCP session" });
    return;
  }
  await transport.handlePostMessage(req, res, req.body);
}

/** POST/GET /api/mcp/stream — Streamable HTTP (MCP 2025-03-26). */
export async function handleMcpStreamableHTTP(req: any, res: any) {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // Existing session → reuse its server+transport
  if (sessionId && streamSessions.has(sessionId)) {
    const { transport } = streamSessions.get(sessionId)!;
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // New session
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (id: string) => {
      streamSessions.set(id, { server, transport });
    },
  } as any);
  res.on("close", () => {
    // keep session for reuse until idle; simple GC on close is fine for now
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

export function isMcpHttpActive(): boolean {
  return sseTransports.size > 0 || streamSessions.size > 0;
}

export function getMcpHttpStatus() {
  return { sseSessions: sseTransports.size, streamableSessions: streamSessions.size };
}

export function shutdownMcpHttp() {
  for (const t of sseTransports.values()) {
    try { t.close(); } catch { /* ignore */ }
  }
  sseTransports.clear();
  streamSessions.clear();
}
