import http from "http";
import https from "https";
import { getSettings } from "../../../../lib/localDb.js";
import { DEFAULT_HEADROOM_URL } from "../../../../lib/headroom/detect.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const DASHBOARD_PREFIX = "/api/headroom/proxy";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

// Headroom proxy binds IPv4 127.0.0.1 only; `localhost` can resolve to ::1 (IPv6)
// in Node and fail. Normalize loopback hostnames to 127.0.0.1.
function normalizeLoopback(host: string): string {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h === "::1" || h === "ip6-localhost") return "127.0.0.1";
  return host;
}

async function getTargetBase(): Promise<string> {
  const settings = await getSettings();
  const url = (settings?.headroomUrl as string) || DEFAULT_HEADROOM_URL;
  const target = new URL(url);
  if (!["http:", "https:"].includes(target.protocol)) {
    throw new Error("Headroom URL must use http or https");
  }
  return url;
}

function forwardedHeaders(req: any, target: URL): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers || {})) {
    if (HOP_BY_HOP_HEADERS.has(k.toLowerCase())) continue;
    if (k.toLowerCase() === "host") continue;
    headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  // Never leak viewer credentials to a non-loopback Headroom host
  if (!LOOPBACK_HOSTS.has(target.hostname.replace(/^\[|\]$/g, "").toLowerCase())) {
    delete headers["cookie"];
    delete headers["authorization"];
  }
  return headers;
}

function rewriteDashboardHtml(html: string): string {
  return html.replace(
    /fetch\('(?=\/(?:stats|health|stats-history|transformations\/feed))/g,
    `fetch('${DASHBOARD_PREFIX}`,
  );
}

// Proxy via core http/https module (bypasses undici fetch, which fails under
// PM2 for loopback IPv4 in some environments).
function proxyRequest(
  method: string,
  targetUrl: string,
  headers: Record<string, string>,
  body?: Buffer,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; chunks: Buffer[] }> {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const lib = target.protocol === "https:" ? https : http;
    const options: http.RequestOptions = {
      method,
      hostname: normalizeLoopback(target.hostname),
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: target.pathname + target.search,
      headers,
      family: 4, // force IPv4 — headroom binds 127.0.0.1 only
    };
    const r = lib.request(options, (resp) => {
      const chunks: Buffer[] = [];
      resp.on("data", (c: Buffer) => chunks.push(c));
      resp.on("end", () =>
        resolve({ status: resp.statusCode || 502, headers: resp.headers, chunks }),
      );
    });
    r.on("error", reject);
    if (body && method !== "GET" && method !== "HEAD") r.write(body);
    r.end();
  });
}

export async function GET(req: any, res: any) {
  try {
    const base = await getTargetBase();
    const target = new URL(base);
    target.hostname = normalizeLoopback(target.hostname);
    const pathSegs = ((req.params?.[0] || req.params?.path || "") + "")
      .split("/")
      .filter(Boolean);
    target.pathname = "/" + pathSegs.join("/");
    target.search = new URL(req.url, "http://x").search;
    console.log("[proxy] forwarding", req.method, "→", target.toString());

    const method = (req.method || "GET").toUpperCase();
    const hasBody = !["GET", "HEAD"].includes(method);
    const fwdHeaders = forwardedHeaders(req, target);
    const bodyBuf = hasBody ? Buffer.from(JSON.stringify(req.body || {})) : undefined;
    if (bodyBuf) fwdHeaders["content-length"] = String(bodyBuf.length);

    const upstream = await proxyRequest(method, target.toString(), fwdHeaders, bodyBuf);

    // Copy headers minus hop-by-hop
    for (const [k, v] of Object.entries(upstream.headers)) {
      if (!v) continue;
      if (HOP_BY_HOP_HEADERS.has(k.toLowerCase())) continue;
      res.setHeader(k, Array.isArray(v) ? v.join(", ") : String(v));
    }

    if (pathSegs.join("/") === "dashboard") {
      const ct = (upstream.headers["content-type"] as string) || "";
      if (ct.includes("text/html")) {
        res.removeHeader("content-length");
        const html = Buffer.concat(upstream.chunks).toString("utf8");
        return res.status(upstream.status).send(rewriteDashboardHtml(html));
      }
    }

    const buf = Buffer.concat(upstream.chunks);
    return res.status(upstream.status).send(buf);
  } catch (e: any) {
    console.error("[proxy] error:", e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}

export const POST = GET;
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
export const HEAD = GET;
export const OPTIONS = GET;
