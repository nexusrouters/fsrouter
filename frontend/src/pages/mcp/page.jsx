import { useEffect, useState } from "react";

export default function McpPage() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);

  async function checkStatus() {
    setLoading(true);
    try {
      const r = await fetch("/api/mcp/status", { headers: { "Content-Type": "application/json" } });
      setStatus(await r.json());
    } catch (e) {
      setStatus({ error: e?.message || String(e) });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { checkStatus(); }, []);

  const base = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <div style={{ padding: 24, maxWidth: 880, margin: "0 auto" }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>MCP Server</h1>
      <p style={{ color: "#888", marginBottom: 20 }}>
        FSRouter exposes its model catalog, providers, and chat routing to AI agents over the
        Model Context Protocol (MCP). Connect any MCP client using the endpoints below.
      </p>

      <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
        <button
          onClick={checkStatus}
          disabled={loading}
          style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #444", background: "#1a1a1a", color: "#fff", cursor: "pointer" }}
        >
          {loading ? "Checking…" : "Refresh Status"}
        </button>
      </div>

      <Section title="Connection Endpoints">
        <Code>Streamable HTTP: {base}/api/mcp/stream</Code>
        <Code>SSE:            {base}/api/mcp/sse</Code>
        <Code>SSE messages:   {base}/api/mcp/message?sessionId=&lt;id&gt;</Code>
      </Section>

      <Section title="Available Tools">
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
          <li><b>health</b> — server health &amp; provider/model counts</li>
          <li><b>list_providers</b> — all configured providers</li>
          <li><b>list_models</b> — model catalog (filter by provider)</li>
          <li><b>route_request</b> — proxy a chat completion through FSRouter</li>
        </ul>
      </Section>

      <Section title="Server Status">
        <pre style={{ background: "#0d0d0d", padding: 16, borderRadius: 8, overflow: "auto" }}>
          {JSON.stringify(status, null, 2)}
        </pre>
      </Section>

      <Section title="Example (Claude Desktop / Cursor)">
        <Code>{`{
  "mcpServers": {
    "fsrouter": {
      "url": "${base}/api/mcp/stream"
    }
  }
}`}</Code>
      </Section>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>{title}</h2>
      {children}
    </div>
  );
}

function Code({ children }) {
  return (
    <div style={{ fontFamily: "monospace", background: "#0d0d0d", padding: "8px 12px", borderRadius: 6, marginBottom: 6, fontSize: 13, overflowX: "auto" }}>
      {children}
    </div>
  );
}
