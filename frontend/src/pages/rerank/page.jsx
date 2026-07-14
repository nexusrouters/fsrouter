import { useState } from "react";

export default function RerankPage() {
  const [query, setQuery] = useState("");
  const [documents, setDocuments] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleRerank = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/rerank", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, documents: documents.split("\n").filter(Boolean) }),
      });
      setResult(await res.json());
    } catch (e) { setResult({ error: e.message }); }
    setLoading(false);
  };

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-bold">Rerank</h1>
      <p className="text-text-muted">Rerank documents by relevance using Cohere-compatible API</p>
      <input className="w-full p-3 rounded-lg border" placeholder="Query" value={query} onChange={e => setQuery(e.target.value)} />
      <textarea className="w-full p-3 rounded-lg border h-40" placeholder="Documents (one per line)" value={documents} onChange={e => setDocuments(e.target.value)} />
      <button onClick={handleRerank} disabled={loading} className="px-4 py-2 bg-primary text-white rounded-lg">{loading ? "Reranking..." : "Rerank"}</button>
      {result && <pre className="p-4 bg-black/5 rounded-lg text-sm overflow-auto">{JSON.stringify(result, null, 2)}</pre>}
    </div>
  );
}
