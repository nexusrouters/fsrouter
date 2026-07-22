import { getMcpHttpStatus } from "../../../lib/mcp/transport.js";

// GET /api/mcp/status — MCP server status
export async function GET(req: any, res: any) {
  try {
    const status = getMcpHttpStatus();
    res.json({
      ok: true,
      active: status.sseSessions > 0 || status.streamable,
      ...status,
      endpoints: {
        streamableHttp: "/api/mcp/stream",
        sse: "/api/mcp/sse",
        message: "/api/mcp/message",
      },
      tools: ["health", "list_providers", "list_models", "route_request"],
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
}
