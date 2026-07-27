import type { Request, Response, NextFunction } from "express";
import http from "http";
import https from "https";

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
  // Strip SRI integrity/crossorigin so CDN assets load even if hash mismatches
  // (Hermes pins sha384; a CDN byte difference would otherwise block the file).
  s = s.replace(/\s+integrity="[^"]*"/g, "");
  s = s.replace(/\s+crossorigin="[^"]*"/g, "");
  // Rewrite CDN (jsdelivr) URLs to same-origin /agent/cdn/ so they are fetched
  // by the fsrouter backend (which can reach the CDN) instead of the client.
  s = s.split("https://cdn.jsdelivr.net/").join("/agent/cdn/");
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
    // Drop X-Frame-Options so fsrouter can embed Hermes in a same-origin iframe.
    if (proxyRes.headers["x-frame-options"]) {
      delete (proxyRes.headers as any)["x-frame-options"];
    }
    Object.entries(proxyRes.headers).forEach(([k, v]) => {
      if (k.toLowerCase() === "location" || k.toLowerCase() === "content-security-policy" || k.toLowerCase() === "x-frame-options") return;
      if (v !== undefined) res.setHeader(k, v as any);
    });
    res.removeHeader("X-Frame-Options");
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
        const rewritten = rewriteBody(buf.toString("utf8"));
        res.type(contentType).send(rewritten);
      } catch {
        res.type(contentType).send(buf);
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

/**
 * Proxies CDN assets (jsdelivr) requested by the Hermes WebUI through the
 * fsrouter backend, so the client does not need direct CDN reachability.
 * Mounted at /agent/cdn/* → https://cdn.jsdelivr.net/*
 */
const CDN_HOST = "cdn.jsdelivr.net";

export function agentCdnProxy(req: Request, res: Response, _next: NextFunction) {
  let upstream = req.url || "/";
  if (upstream.startsWith("/agent/cdn/")) {
    upstream = upstream.slice("/agent/cdn".length) || "/";
  }
  if (!upstream.startsWith("/")) upstream = "/" + upstream;

  const options: http.RequestOptions = {
    host: CDN_HOST,
    port: 443,
    path: upstream,
    method: req.method,
    headers: {
      ...req.headers,
      host: CDN_HOST,
    },
    protocol: "https:" as any,
  };
  delete (options.headers as any)["connection"];

  const proxyReq = https.request(options, (proxyRes) => {
    Object.entries(proxyRes.headers).forEach(([k, v]) => {
      if (v !== undefined) res.setHeader(k, v as any);
    });
    res.statusCode = proxyRes.statusCode || 502;
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (err) => {
    if (!res.headersSent) {
      res.status(502).json({ error: "CDN unreachable", detail: err.message });
    } else {
      res.end();
    }
  });

  req.pipe(proxyReq);
}
