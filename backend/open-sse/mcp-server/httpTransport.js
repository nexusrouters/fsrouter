import { randomUUID } from "node:crypto";
import { createMcpServer } from "./server.ts";
import { withMcpHttpAuthContext } from "./httpAuthContext.ts";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
let _sseServer = null;
let _sseTransport = null;
let _sseStartedAt = null;
const _streamableSessions = /* @__PURE__ */ new Map();
const MCP_SESSION_IDLE_MS = 5 * 60 * 1e3;
const _mcpSessionSweep = setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of _streamableSessions) {
    if (now - session.lastActivityAt > MCP_SESSION_IDLE_MS) {
      try {
        closeStreamableSession(sessionId);
      } catch {
      }
    }
  }
}, 6e4);
if (typeof _mcpSessionSweep === "object" && "unref" in _mcpSessionSweep) {
  _mcpSessionSweep.unref?.();
}
function closeSseTransport() {
  if (_sseTransport) {
    try {
      _sseTransport.close();
    } catch {
    }
  }
  _sseServer = null;
  _sseTransport = null;
  _sseStartedAt = null;
}
function closeStreamableSession(sessionId) {
  const session = _streamableSessions.get(sessionId);
  if (!session) {
    return;
  }
  try {
    session.transport.close();
  } catch {
  }
  _streamableSessions.delete(sessionId);
}
function closeAllStreamableSessions() {
  for (const sessionId of _streamableSessions.keys()) {
    closeStreamableSession(sessionId);
  }
}
function ensureSseServer() {
  if (_sseServer && _sseTransport) {
    return { server: _sseServer, transport: _sseTransport };
  }
  closeAllStreamableSessions();
  _sseServer = createMcpServer();
  _sseTransport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID()
  });
  _sseStartedAt = Date.now();
  void _sseServer.connect(_sseTransport);
  console.log("[MCP] HTTP transport started (sse)");
  return { server: _sseServer, transport: _sseTransport };
}
function createStreamableSession() {
  closeSseTransport();
  const sessionId = randomUUID();
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId
  });
  const session = {
    sessionId,
    server,
    transport,
    startedAt: Date.now(),
    lastActivityAt: Date.now()
  };
  void server.connect(transport);
  _streamableSessions.set(sessionId, session);
  console.log(`[MCP] HTTP transport started (streamable-http:${sessionId})`);
  return session;
}
async function isInitializeRequest(request) {
  if (request.method !== "POST") {
    return false;
  }
  try {
    const body = await request.clone().json();
    return body?.method === "initialize";
  } catch {
    return false;
  }
}
function errorResponse(message, code, status = 400) {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null
    }),
    {
      status,
      headers: { "Content-Type": "application/json" }
    }
  );
}
function withSessionHeader(response, sessionId) {
  if (response.headers.get("mcp-session-id")) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("mcp-session-id", sessionId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
async function handleStreamableRequest(request) {
  const sessionId = request.headers.get("mcp-session-id");
  if (sessionId) {
    const session2 = _streamableSessions.get(sessionId);
    if (!session2) {
      if (await isInitializeRequest(request)) {
        const newSession = createStreamableSession();
        try {
          const response = await withMcpHttpAuthContext(
            request,
            () => newSession.transport.handleRequest(request)
          );
          return withSessionHeader(response, newSession.sessionId);
        } catch (err) {
          closeStreamableSession(newSession.sessionId);
          console.error("[MCP] Streamable HTTP error during stale-session recovery:", err);
          return new Response(JSON.stringify({ error: "MCP transport error" }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
          });
        }
      }
      return errorResponse("Not Found: Unknown Mcp-Session-Id header", -32e3, 404);
    }
    try {
      session2.lastActivityAt = Date.now();
      const response = await withMcpHttpAuthContext(
        request,
        () => session2.transport.handleRequest(request)
      );
      if (request.method === "DELETE") {
        closeStreamableSession(sessionId);
      }
      return withSessionHeader(response, sessionId);
    } catch (err) {
      console.error("[MCP] Streamable HTTP error:", err);
      if (request.method === "DELETE") {
        closeStreamableSession(sessionId);
      }
      return new Response(JSON.stringify({ error: "MCP transport error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
  if (!await isInitializeRequest(request)) {
    return errorResponse("Bad Request: Mcp-Session-Id header is required", -32e3);
  }
  const session = createStreamableSession();
  try {
    const response = await withMcpHttpAuthContext(
      request,
      () => session.transport.handleRequest(request)
    );
    return withSessionHeader(response, session.sessionId);
  } catch (err) {
    closeStreamableSession(session.sessionId);
    console.error("[MCP] Streamable HTTP error:", err);
    return new Response(JSON.stringify({ error: "MCP transport error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
async function handleMcpStreamableHTTP(request) {
  return handleStreamableRequest(request);
}
async function handleMcpSSE(request) {
  const { transport } = ensureSseServer();
  try {
    return await withMcpHttpAuthContext(request, () => transport.handleRequest(request));
  } catch (err) {
    console.error("[MCP] SSE error:", err);
    return new Response(JSON.stringify({ error: "MCP SSE transport error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
function getMcpHttpStatus() {
  const streamableStartedAt = _streamableSessions.size > 0 ? Math.min(...Array.from(_streamableSessions.values(), (session) => session.startedAt)) : null;
  const startedAt = streamableStartedAt ?? _sseStartedAt;
  const transport = _streamableSessions.size > 0 ? "streamable-http" : _sseTransport ? "sse" : null;
  const online = transport !== null;
  return {
    online,
    transport,
    startedAt,
    uptime: startedAt ? `${Math.floor((Date.now() - startedAt) / 1e3)}s` : null
  };
}
function isMcpHttpTransportReady(enabled, transport) {
  return enabled && (transport === "sse" || transport === "streamable-http");
}
function shutdownMcpHttp() {
  closeSseTransport();
  closeAllStreamableSessions();
  console.log("[MCP] HTTP transport shutdown");
}
function isMcpHttpActive() {
  return _sseTransport !== null || _streamableSessions.size > 0;
}
export {
  getMcpHttpStatus,
  handleMcpSSE,
  handleMcpStreamableHTTP,
  isMcpHttpActive,
  isMcpHttpTransportReady,
  shutdownMcpHttp
};
