import { useState, useEffect } from "react";
import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";

export default function ModerationsPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <ModerationsContent />
    </Suspense>
  );
}

function ModerationsContent() {
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [result, setResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState("");
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch("/api/media-providers/moderation")
      .then((res) => res.json())
      .then((data) => {
        setProviders(Array.isArray(data) ? data : []);
        if (data.length > 0) setSelectedProvider(data[0].id);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleTest = async () => {
    if (!input.trim()) return;
    setTesting(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/media/moderation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input, providerId: selectedProvider || undefined }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <div className="flex items-center gap-3">
        <span className="material-symbols-outlined text-[28px] text-primary">shield</span>
        <h1 className="text-xl font-semibold text-text-main">Moderations</h1>
      </div>

      {/* Providers */}
      <div className="rounded-xl border border-border-subtle bg-surface p-4">
        <h2 className="text-sm font-semibold text-text-main mb-3">Moderation Providers</h2>
        {loading ? (
          <p className="text-xs text-text-muted">Loading providers...</p>
        ) : providers.length === 0 ? (
          <p className="text-xs text-text-muted">No moderation providers configured. Add one in Media Providers.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {providers.map((p) => (
              <button
                key={p.id}
                onClick={() => setSelectedProvider(p.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                  selectedProvider === p.id
                    ? "bg-primary/10 text-primary border border-primary/30"
                    : "bg-surface-2 text-text-muted hover:text-text-main border border-transparent"
                }`}
              >
                {p.name || p.id}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Test Input */}
      <div className="rounded-xl border border-border-subtle bg-surface p-4">
        <h2 className="text-sm font-semibold text-text-main mb-3">Test Moderation</h2>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Enter text to moderate..."
          rows={4}
          className="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-sm text-text-main placeholder:text-text-muted/50 focus:outline-none focus:ring-1 focus:ring-primary/50 resize-none mb-3"
        />
        <button
          onClick={handleTest}
          disabled={testing || !input.trim()}
          className="px-4 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors cursor-pointer"
        >
          {testing ? "Testing..." : "Run Moderation"}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="rounded-xl border border-border-subtle bg-surface p-4">
          <h2 className="text-sm font-semibold text-text-main mb-3">Result</h2>
          <pre className="text-xs text-text-muted overflow-auto max-h-96 bg-surface-2 rounded-lg p-3 font-mono whitespace-pre-wrap">
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
