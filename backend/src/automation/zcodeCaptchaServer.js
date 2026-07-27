/**
 * ZCode Aliyun captcha bridge.
 *
 * fsrouter calls this over HTTP when an upstream ZCode request returns
 * error 3007 (captcha verify failed). We shell out to the Playwright
 * solver (zcode_captcha.py) which loads the real Aliyun SDK, runs
 * traceless verification (or solves the slider), and returns a fresh
 * X-Aliyun-Captcha-Verify-Param token.
 *
 * IMPORTANT: this only works from a RESIDENTIAL IP (laptop / home).
 * From a datacenter VPS the Aliyun risk backend drops the verification
 * request silently (proven: success/onError never fire). On a laptop
 * with real Chrome (channel="chrome") traceless passes without a slider.
 *
 * Token is cached for 55s (ZCode source reuses certifyId ~60s).
 */
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const PORT = Number(process.env.ZCODE_CAPTCHA_PORT || 18765);
const SOLVER = path.join(import.meta.dirname, "zcode_captcha.py");
const PYTHON = process.env.ZCODE_CAPTCHA_PYTHON || "python3";
const CACHE_TTL = 55_000;

/** @type {{token:string, region:string, expires:number} | null} */
let cache = null;
/** @type {Promise<any> | null} */
let inflight = null;

function solve() {
  if (cache && Date.now() < cache.expires) {
    return Promise.resolve(cache);
  }
  if (inflight) return inflight;

  inflight = new Promise((resolve, reject) => {
    const env = { ...process.env };
    // inherit ZCODE_CAPTCHA_PROXY / ZCODE_CHROME_PATH if set
    const py = spawn(PYTHON, [SOLVER], { env, timeout: 120_000 });
    let out = "";
    let err = "";
    py.stdout.on("data", (d) => (out += d.toString()));
    py.stderr.on("data", (d) => (err += d.toString()));
    py.on("close", (code) => {
      inflight = null;
      try {
        const last = out.trim().split("\n").filter(Boolean).pop() || "{}";
        const j = JSON.parse(last);
        if (j.success && j.verifyParam) {
          cache = {
            token: j.verifyParam,
            region: j.region || "sgp",
            expires: Date.now() + CACHE_TTL,
          };
          resolve(cache);
        } else {
          reject(new Error(j.error || `solver_exit_${code}`));
        }
      } catch (e) {
        reject(new Error(err.slice(-300) || "solver_parse_error"));
      }
    });
    py.on("error", (e) => {
      inflight = null;
      reject(e);
    });
  });
  return inflight;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/solve") {
    try {
      const r = await solve();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, cached: !!cache }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[zcode-captcha-bridge] listening on 127.0.0.1:${PORT}`);
});
