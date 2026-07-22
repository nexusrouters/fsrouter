import { handleMcpMessage } from "../../../lib/mcp/transport.js";

// MCP SSE client→server messages — POST /api/mcp/message?sessionId=...
export async function POST(req: any, res: any) {
  try {
    await handleMcpMessage(req, res);
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ error: e?.message || String(e) });
  }
}
