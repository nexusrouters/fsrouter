import { useState } from "react";

export default function WebFetchPage() {
  const [url, setUrl] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleFetch = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/web/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      setResult(await res.json());
    } catch (e) { setResult({ error: e.message }); }
    setLoading(false);
  };

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-bold">Web Fetch</h1>
      <p className="text-text-muted">Fetch web content via Firecrawl, Jina, Tavily, or TinyFish</p>
      <div className="flex gap-2">
        <input className="flex-1 p-3 rounded-lg border" placeholder="https://example.com" value={url} onChange={e => setUrl(e.target.value)} />
        <button onClick={handleFetch} disabled={loading} className="px-4 py-2 bg-primary text-white rounded-lg">{loading ? "Fetching..." : "Fetch"}</button>
      </div>
      {result && <pre className="p-4 bg-black/5 rounded-lg text-sm overflow-auto max-h-96">{JSON.stringify(result, null, 2)}</pre>}
    </div>
  );
}
