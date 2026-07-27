import type { Request, Response, NextFunction } from "express";
import http from "http";

/**
 * Reverse proxy that mounts the standalone Hermes WebUI (Python service,
 * normally on 127.0.0.1:8790) under the fsrouter path `/agent`.
 *
 * Hermes WebUI serves absolute asset paths (/static, /api, /manifest.json).
 * To make it work seamlessly on the same port/origin as fsrouter we rewrite
 * those absolute paths to the /agent-prefixed equivalents in both the proxied
 * HTML/JS/CSS bodies and any Location/redirect headers.
 *
 * This keeps a single port (fsrouter's) and avoids iframes (which Hermes
 * blocks via CSP frame-ancestors: 'none').
 */

const TARGET_HOST = process.env.HERMES_WEBUI_HOST || "127.0.0.1";
const TARGET_PORT = Number(process.env.HERMES_WEBUI_PORT || 8790);
const MOUNT = "/agent";

function rewriteBody(chunk: string): string {
  let s = chunk;
  // HTML attribute paths (relative, no leading slash)
  s = s.split('href="static/').join('href="/agent/static/');
  s = s.split('src="static/').join('src="/agent/static/');
  s = s.split('href="manifest.json"').join('href="/agent/manifest.json"');
  s = s.split('href="favicon').join('href="/agent/favicon');
  s = s.split('src="favicon').join('src="/agent/favicon');
  // JS string literals: "/api/..." and '/api/...' (only if not already prefixed)
  s = s.split('"/api/').join('"/agent/api/');
  s = s.split("'/api/").join("'/agent/api/");
  return s;
}

export function agentProxy(req: Request, res: Response, _next: NextFunction) {
  let upstreamPath = req.url || "/";
  if (upstreamPath.startsWith(MOUNT)) {
    upstreamPath = upstreamPath.slice(MOUNT.length) || "/";
  }
  if (!upstreamPath.startsWith("/")) upstreamPath = "/" + upstreamPath;

  const rawQuery = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  const fullPath = upstreamPath + rawQuery;

  const headers: Record<string, any> = { ...req.headers };
  headers["host"] = TARGET_HOST + ":" + TARGET_PORT;
  delete headers["connection"];

  const options: http.RequestOptions = {
    host: TARGET_HOST,
    port: TARGET_PORT,
    path: fullPath,
    method: req.method,
    headers,
  };

  const proxyReq = http.request(options, (proxyRes) => {
    const contentType = (proxyRes.headers["content-type"] as string) || "";
    const isText =
      contentType.includes("text/") ||
      contentType.includes("javascript") ||
      contentType.includes("css") ||
      contentType.includes("json");

    if (proxyRes.headers["location"]) {
      let loc = proxyRes.headers["location"] as string;
      if (loc.startsWith("/")) loc = MOUNT + loc;
      res.setHeader("Location", loc);
    }
    if (proxyRes.headers["content-security-policy"]) {
      const csp = (proxyRes.headers["content-security-policy"] as string)
        .replace(/frame-ancestors[^;]*;?/g, "")
        .replace(/frame-ancestors[^;]*$/g, "");
      res.setHeader("Content-Security-Policy", csp);
      delete (proxyRes.headers as any)["content-security-policy"];
    }
    // Hermes sends CSP as Report-Only; strip frame-ancestors so embedding
    // inside fsrouter's same-origin iframe is allowed.
    if (proxyRes.headers["content-security-policy-report-only"]) {
      const cspRo = (proxyRes.headers["content-security-policy-report-only"] as string)
        .replace(/frame-ancestors[^;]*;?/g, "")
        .replace(/frame-ancestors[^;]*$/g, "");
      res.setHeader("Content-Security-Policy-Report-Only", cspRo);
      delete (proxyRes.headers as any)["content-security-policy-report-only"];
    }
    Object.entries(proxyRes.headers).forEach(([k, v]) => {
      if (k.toLowerCase() === "location" || k.toLowerCase() === "content-security-policy") return;
      if (v !== undefined) res.setHeader(k, v as any);
    });
    res.statusCode = proxyRes.statusCode || 502;

    if (!isText) {
      proxyRes.pipe(res);
      return;
    }

    const chunks: Buffer[] = [];
    proxyRes.on("data", (c) => chunks.push(c as Buffer));
    proxyRes.on("end", () => {
      const buf = Buffer.concat(chunks);
      try {
        res.send(rewriteBody(buf.toString("utf8")));
      } catch {
        res.send(buf);
      }
    });
  });

  proxyReq.on("error", (err) => {
    if (!res.headersSent) {
      res.status(502).json({ error: "Agent service unreachable", detail: err.message });
    } else {
      res.end();
    }
  });

  req.pipe(proxyReq);
}
