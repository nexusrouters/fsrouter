import { useState, useEffect } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import { Suspense } from "react";

export default function SearchPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <SearchContent />
    </Suspense>
  );
}

function SearchContent() {
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState("");
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch("/api/media-providers/webSearch")
      .then((res) => res.json())
      .then((data) => {
        setProviders(Array.isArray(data) ? data : []);
        if (data.length > 0) setSelectedProvider(data[0].id);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    setResults(null);
    try {
      const res = await fetch("/api/media/webSearch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, providerId: selectedProvider || undefined }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setResults(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <div className="flex items-center gap-3">
        <span className="material-symbols-outlined text-[28px] text-primary">search</span>
        <h1 className="text-xl font-semibold text-text-main">Search</h1>
      </div>

      {/* Providers */}
      <div className="rounded-xl border border-border-subtle bg-surface p-4">
        <h2 className="text-sm font-semibold text-text-main mb-3">Search Providers</h2>
        {loading ? (
          <p className="text-xs text-text-muted">Loading providers...</p>
        ) : providers.length === 0 ? (
          <p className="text-xs text-text-muted">No search providers configured. Add one in Media Providers.</p>
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

      {/* Search Input */}
      <div className="rounded-xl border border-border-subtle bg-surface p-4">
        <h2 className="text-sm font-semibold text-text-main mb-3">Test Search</h2>
        <div className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder="Enter search query..."
            className="flex-1 rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-sm text-text-main placeholder:text-text-muted/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
          <button
            onClick={handleSearch}
            disabled={searching || !query.trim()}
            className="px-4 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors cursor-pointer"
          >
            {searching ? "Searching..." : "Search"}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Results */}
      {results && (
        <div className="rounded-xl border border-border-subtle bg-surface p-4">
          <h2 className="text-sm font-semibold text-text-main mb-3">Results</h2>
          <pre className="text-xs text-text-muted overflow-auto max-h-96 bg-surface-2 rounded-lg p-3 font-mono whitespace-pre-wrap">
            {JSON.stringify(results, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
