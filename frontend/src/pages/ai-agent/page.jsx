import { useEffect, useState } from "react";

export default function AIAgentPage() {
  const [url, setUrl] = useState("");

  useEffect(() => {
    // Hermes WebUI runs as a separate service on port 8790 (PM2: hermes-webui).
    // We load it inside an iframe so it appears as a menu inside fsrouter.
    const proto = window.location.protocol;
    const host = window.location.hostname;
    setUrl(`${proto}//${host}:8790/`);
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0, top: 0, left: 0, right: 0, bottom: 0, height: "100vh", width: "100vw", background: "#0f1115" }}>
      {url ? (
        <iframe
          src={url}
          title="Hermes AI Agent"
          style={{ width: "100%", height: "100%", border: "none" }}
          allow="clipboard-read; clipboard-write; microphone; camera"
        />
      ) : (
        <div style={{ color: "#888", padding: 24 }}>Loading AI Agent…</div>
      )}
    </div>
  );
}
