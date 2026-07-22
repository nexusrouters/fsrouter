import { handleMcpStreamableHTTP } from "../../../lib/mcp/transport.js";

// MCP Streamable HTTP — POST/GET /api/mcp/stream
export async function POST(req: any, res: any) {
  try {
    await handleMcpStreamableHTTP(req, res);
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ error: e?.message || String(e) });
  }
}

export async function GET(req: any, res: any) {
  try {
    await handleMcpStreamableHTTP(req, res);
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ error: e?.message || String(e) });
  }
}
