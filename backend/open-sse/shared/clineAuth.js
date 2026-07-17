import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve package.json by walking up — works in both src (open-sse/shared)
// and dist (dist/open-sse/shared) layouts.
function resolvePkgPath() {
  let d = __dirname;
  for (let i = 0; i < 6; i++) {
    const p = `${d}/package.json`;
    if (existsSync(p)) return p;
    d = dirname(d);
  }
  return null;
}

const _require = createRequire(import.meta.url);
const _pkgPath = resolvePkgPath();
const APP_VERSION = _pkgPath ? _require(_pkgPath).version || "0.0.0" : "0.0.0";

export function getClineAccessToken(token) {
  if (typeof token !== "string") return "";
  const trimmed = token.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("workos:") ? trimmed : `workos:${trimmed}`;
}

export function getClineAuthorizationHeader(token) {
  const accessToken = getClineAccessToken(token);
  return accessToken ? `Bearer ${accessToken}` : "";
}

export function buildClineHeaders(token, extraHeaders = {}) {
  const authorization = getClineAuthorizationHeader(token);
  const headers = {
    "HTTP-Referer": "https://cline.bot",
    "X-Title": "Cline",
    "User-Agent": `9Router/${APP_VERSION}`,
    "X-PLATFORM": process.platform || "unknown",
    "X-PLATFORM-VERSION": process.version || "unknown",
    "X-CLIENT-TYPE": "9router",
    "X-CLIENT-VERSION": APP_VERSION,
    "X-CORE-VERSION": APP_VERSION,
    "X-IS-MULTIROOT": "false",
    ...extraHeaders,
  };

  if (authorization) {
    headers.Authorization = authorization;
  }

  return headers;
}
