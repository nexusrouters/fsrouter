/**
 * Web Fetch Handler
 *
 * Handles POST /v1/web/fetch requests.
 * Dispatches to a web-fetch provider executor (Firecrawl, Jina Reader, Tavily, or TinyFish).
 *
 * Request format:
 * {
 *   "url": "https://example.com",
 *   "provider": "firecrawl" | "jina-reader" | "tavily-search" | "tinyfish",  // optional
 *   "format": "markdown" | "html" | "links" | "screenshot",
 *   "depth": 0 | 1 | 2,
 *   "wait_for_selector": "main",
 *   "include_metadata": true
 * }
 */

import { buildErrorBody } from "../utils/error.js";

// ── Inline sanitizeErrorMessage stub ─────────────────────────────────
function sanitizeErrorMessage(message) {
  if (typeof message !== "string") return "An error occurred";
  return message.replace(/\/[^\s]+\/node_modules/g, "[node_modules]");
}

// ── Provider executor stubs ──────────────────────────────────────────
// These are placeholders; real implementations should be wired up from
// the executors/ directory when available.

async function firecrawlFetch({ url, format, depth, waitForSelector, includeMetadata, credentials }) {
  const apiKey = credentials?.apiKey;
  if (!apiKey) return { success: false, status: 401, error: "Firecrawl API key required" };

  const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ url, formats: [format], waitForSelector, depth }),
  });

  if (!res.ok) {
    const errText = await res.text();
    return { success: false, status: res.status, error: sanitizeErrorMessage(errText) };
  }

  const data = await res.json();
  const content = data?.data?.markdown || data?.data?.html || "";
  const metadata = includeMetadata
    ? { title: data?.data?.metadata?.title || null, description: data?.data?.metadata?.description || null }
    : null;

  return {
    success: true,
    data: { provider: "firecrawl", url, content, links: [], metadata, screenshot_url: null },
  };
}

async function jinaReaderFetch({ url, format, includeMetadata, credentials }) {
  const headers = { Accept: "application/json" };
  if (credentials?.apiKey) headers["Authorization"] = `Bearer ${credentials.apiKey}`;

  const res = await fetch(`https://r.jina.ai/${url}`, { headers });
  if (!res.ok) {
    const errText = await res.text();
    return { success: false, status: res.status, error: sanitizeErrorMessage(errText) };
  }

  const data = await res.json();
  const content = data?.data?.content || data?.data?.markdown || "";
  const metadata = includeMetadata
    ? { title: data?.data?.title || null, description: data?.data?.description || null }
    : null;

  return {
    success: true,
    data: { provider: "jina-reader", url, content, links: [], metadata, screenshot_url: null },
  };
}

async function tavilyFetch({ url, format, includeMetadata, credentials }) {
  const apiKey = credentials?.apiKey;
  if (!apiKey) return { success: false, status: 401, error: "Tavily API key required" };

  const res = await fetch("https://api.tavily.com/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, urls: [url] }),
  });

  if (!res.ok) {
    const errText = await res.text();
    return { success: false, status: res.status, error: sanitizeErrorMessage(errText) };
  }

  const data = await res.json();
  const result = data?.results?.[0] || {};
  const content = result.raw_content || result.content || "";
  const metadata = includeMetadata
    ? { title: result.title || null, description: null }
    : null;

  return {
    success: true,
    data: { provider: "tavily-search", url, content, links: [], metadata, screenshot_url: null },
  };
}

async function tinyfishFetch({ url, format, includeMetadata, credentials }) {
  const apiKey = credentials?.apiKey;
  if (!apiKey) return { success: false, status: 401, error: "TinyFish API key required" };

  const res = await fetch("https://api.tinyfish.io/v1/fetch", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ url, format }),
  });

  if (!res.ok) {
    const errText = await res.text();
    return { success: false, status: res.status, error: sanitizeErrorMessage(errText) };
  }

  const data = await res.json();
  const content = data?.content || "";
  const metadata = includeMetadata
    ? { title: data?.title || null, description: data?.description || null }
    : null;

  return {
    success: true,
    data: { provider: "tinyfish", url, content, links: data?.links || [], metadata, screenshot_url: null },
  };
}

// ── Constants ────────────────────────────────────────────────────────
const WEB_FETCH_PROVIDERS = ["firecrawl", "jina-reader", "tavily-search", "tinyfish"];

/**
 * Execute a web fetch request against the specified (or auto-selected) provider.
 */
export async function handleWebFetch(req, credentials, resolvedProvider) {
  const provider = resolvedProvider ?? req.provider ?? "firecrawl";

  const format = req.format ?? "markdown";
  const includeMetadata = req.include_metadata ?? false;

  try {
    switch (provider) {
      case "firecrawl":
        return await firecrawlFetch({
          url: req.url,
          format,
          depth: req.depth ?? 0,
          waitForSelector: req.wait_for_selector,
          includeMetadata,
          credentials,
        });

      case "jina-reader":
        return await jinaReaderFetch({
          url: req.url,
          format,
          includeMetadata,
          credentials,
        });

      case "tavily-search":
        return await tavilyFetch({
          url: req.url,
          format,
          includeMetadata,
          credentials,
        });

      case "tinyfish":
        return await tinyfishFetch({
          url: req.url,
          format,
          includeMetadata,
          credentials,
        });

      default: {
        return {
          success: false,
          status: 400,
          error: `Unknown web fetch provider: ${provider}`,
        };
      }
    }
  } catch (err) {
    const msg =
      err instanceof Error ? sanitizeErrorMessage(err.message) : sanitizeErrorMessage(String(err));
    const body = buildErrorBody(502, msg);
    return {
      success: false,
      status: 502,
      error: body.error.message,
    };
  }
}
