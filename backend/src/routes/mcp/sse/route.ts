import { handleMcpSSE } from "../../../lib/mcp/transport.js";

// MCP SSE endpoint — GET /api/mcp/sse
export async function GET(req: any, res: any) {
  try {
    await handleMcpSSE(req, res);
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ error: e?.message || String(e) });
  }
}
