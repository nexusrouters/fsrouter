import { useEffect, useState } from "react";

// The Hermes WebUI (AI Agent) is served by the fsrouter backend reverse proxy
// at the same-origin path /agent (port 20266, no separate port, no redirect).
// We render it directly inside the fsrouter content area via an iframe.
// (The proxy strips Hermes' CSP frame-ancestors:'none' so embedding is allowed.)
export default function AIAgentPage() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(true);
  }, []);

  return (
    <div style={{ position: "absolute", inset: 0, height: "100%", width: "100%", background: "#0f1115" }}>
      {ready && (
        <iframe
          src="/agent/"
          title="Hermes AI Agent"
          style={{ width: "100%", height: "100%", border: "none", display: "block" }}
          allow="clipboard-read; clipboard-write; microphone; camera"
        />
      )}
    </div>
  );
}
