import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { authMiddleware } from "./middleware/auth.js";
import { buildAutoRouter } from "./autoRouter.js";

const PORT = Number(process.env.PORT) || 3001;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5177";

const app = express();

// ─── Security ─────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, callback) => {
    callback(null, origin || true);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-api-key", "x-9r-cli-token"],
}));

// ─── Body Parsing ─────────────────────────────────────────────────────────────
app.use(cookieParser());
app.use(express.json({ limit: "128mb" }));
app.use(express.urlencoded({ extended: true, limit: "128mb" }));

// ─── Serve Static Frontend Assets ─────────────────────────────────────────────
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
app.use(express.static(join(__dirname, "../public")));

const SPA_ROUTES = ["/dashboard", "/login", "/init", "/settings", "/providers", "/keys", "/models", "/usage", "/combos", "/media-providers"];
SPA_ROUTES.forEach((route) => {
  app.get(new RegExp(`^${route}`), (_req, res) => {
    res.sendFile(join(__dirname, "../public/index.html"));
  });
});

// ─── Health Check (no auth) ────────────────────────────────────────────────────
import { getAppVersion } from "./lib/db/version.js";
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", version: getAppVersion(), ts: Date.now() });
});

// ─── Auto-start tunnel on boot if previously enabled ─────────────────────────
import { getSettings } from "./lib/localDb.js";
import { enableTunnel } from "./lib/tunnel/cloudflare/manager.js";
import { isCloudflaredRunning } from "./lib/tunnel/cloudflare/cloudflared.js";
async function bootstrapTunnel() {
  try {
    const settings = await getSettings();
    if (settings?.tunnelEnabled !== true) return;
    // Cloudflared is spawned detached (daemon) → it survives PM2 restarts on its own.
    // Only enable if NOT already running (avoid duplicate spawn / fighting).
    if (isCloudflaredRunning()) {
      console.log("[server] tunnel already running (detached daemon) → skip auto-start");
      return;
    }
    console.log("[server] tunnel settingsEnabled=true → auto-starting cloudflared");
    enableTunnel(Number(process.env.PORT) || 3001).catch((e) =>
      console.warn("[server] tunnel auto-start failed:", e?.message || e)
    );
  } catch (e) {
    console.warn("[server] tunnel bootstrap error:", e?.message || e);
  }
}

// ─── Auto-start Headroom proxy on boot if enabled ───────────────────────────
import { getManagedPid, isPidAlive } from "./lib/headroom/process.js";
import { startHeadroomProxy } from "./lib/headroom/process.js";
import { DEFAULT_HEADROOM_URL } from "./lib/headroom/detect.js";
async function bootstrapHeadroom() {
  console.log("[server] bootstrapHeadroom: invoked");
  try {
    const settings = await getSettings();
    console.log("[server] bootstrapHeadroom: headroomEnabled=", settings?.headroomEnabled);
    if (settings?.headroomEnabled !== true) return;
    // Prefer the persisted managed pid (instant, survives detached spawn) over
    // a slow network probe. Only start if no live managed process exists.
    const pid = getManagedPid();
    if (pid && isPidAlive(pid)) {
      console.log("[server] headroom already running (managed pid) → skip auto-start");
      return;
    }
    const url = settings?.headroomUrl || DEFAULT_HEADROOM_URL;
    console.log("[server] headroomEnabled=true → auto-starting headroom proxy");
    await startHeadroomProxy({ port: Number(new URL(url).port) || 8787 });
  } catch (e) {
    console.warn("[server] headroom bootstrap error:", e?.message || e);
  }
}

// ─── Auth Middleware ───────────────────────────────────────────────────────────
app.use(authMiddleware);

// ─── Auto-mount all routes ────────────────────────────────────────────────────
async function start() {
  const apiRouter = await buildAutoRouter();
  app.use("/api", (req, res, next) => {
    console.log("API request:", req.method, req.url, req.originalUrl);
    apiRouter(req, res, next);
  });

  // LLM proxy remaps: /v1/* → /api/v1/*
  app.use("/v1", (req, res, next) => {
    req.url = "/v1" + req.url;
    apiRouter(req, res, next);
  });
  app.use("/v1beta", (req, res, next) => {
    req.url = "/v1beta" + req.url;
    apiRouter(req, res, next);
  });

  // ─── 404 Fallback ──────────────────────────────────────────────────────────
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));

  // ─── Error Handler ─────────────────────────────────────────────────────────
  app.use((err, _req, res, _next) => {
    console.error("[server] unhandled error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  });

  app.listen(PORT, () => {
    console.log(`\n🚀 9Router Backend v2 running on http://localhost:${PORT}`);
    console.log(`   Frontend origin: ${FRONTEND_ORIGIN}`);
    console.log(`   Environment: ${process.env.NODE_ENV || "development"}\n`);
    // Auto-start tunnel if it was enabled before restart (avoids "Tunnel checking..." stuck)
    bootstrapTunnel();
    // Auto-start headroom proxy if it was enabled before restart (survives PM2 restart)
    Promise.resolve().then(bootstrapHeadroom).catch((e) =>
      console.warn("[server] headroom bootstrap threw:", e?.message || e),
    );
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

export { app };

