import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import {
  createProviderConnection,
  getProviderConnections,
  updateProviderConnection,
  deleteProviderConnection,
} from "../../../lib/db/index.js";

export const dynamic = "force-dynamic";

// ── Global state for openvecta automation ──────────────────────────────────────
if (!global._openvectaState) {
  global._openvectaState = {
    activeJobId: null,
    stopFlag: false,
    activeProcesses: new Set(),
  };
}

// ── GET: Status ───────────────────────────────────────────────────────────────
export async function GET(req, res) {
  try {
    const connections = await getProviderConnections({ provider: "openvecta" });
    const activeJobId = global._openvectaState.activeJobId || null;

    return res.json({
      ok: true,
      connections: connections.map(c => ({
        id: c.id,
        name: c.name,
        email: c.email,
        apiKey: c.apiKey ? `${c.apiKey.substring(0, 20)}...` : null,
        isActive: c.isActive,
        testStatus: c.testStatus,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      })),
      active_job_id: activeJobId,
    });
  } catch (error) {
    console.error("Error in GET /api/automation/openvecta:", error);
    return res.status(500).json({ error: error.message });
  }
}

// ── POST: Actions ─────────────────────────────────────────────────────────────
export async function POST_handler(req, res) {
  try {
    const body = req.body;
    const { action } = body;

    // ── Action: Start signup ──────────────────────────────────────────────
    if (action === "start-signup") {
      const { email, password, fsmail_base_url, fsmail_api_key, fsmail_domain, headless, proxy } = body;

      if (!email) {
        return res.status(400).json({ error: "email is required" });
      }

      if (global._openvectaState.activeJobId) {
        return res.status(400).json({ error: "Ada job lain yang sedang berjalan." });
      }

      const jobId = uuidv4();
      global._openvectaState.activeJobId = jobId;
      global._openvectaState.stopFlag = false;

      // Spawn Python script
      const venvPython = path.resolve(process.cwd(), ".venv/bin/python");
      const scriptPath = path.resolve(process.cwd(), "src/automation/openvecta_signup.py");
      const profilesDir = path.resolve(process.cwd(), "profiles/openvecta");

      const args = [
        scriptPath,
        `--email=${email}`,
        `--password=${password || "placeholder"}`,
        `--profiles-dir=${profilesDir}`,
      ];

      if (fsmail_base_url && fsmail_api_key && fsmail_domain) {
        args.push(`--ammail-base-url=${fsmail_base_url}`);
        args.push(`--ammail-api-key=${fsmail_api_key}`);
        args.push(`--ammail-domain=${fsmail_domain}`);
      }

      if (headless !== false) {
        args.push("--headless");
      }

      if (proxy) {
        try {
          const proxyObj = typeof proxy === "string" ? JSON.parse(proxy) : proxy;
          if (proxyObj.server) args.push(`--proxy-server=${proxyObj.server}`);
          if (proxyObj.username) args.push(`--proxy-user=${proxyObj.username}`);
          if (proxyObj.password) args.push(`--proxy-pass=${proxyObj.password}`);
        } catch (e) {
          console.error("Failed to parse proxy:", e);
        }
      }

      // Run async
      runOpenVectaSignup(jobId, email, venvPython, args).catch(console.error);

      return res.json({ ok: true, job_id: jobId, message: "OpenVecta signup dimulai." });
    }

    // ── Action: Test connection ───────────────────────────────────────────
    if (action === "test-connection") {
      const { connection_id, api_key } = body;

      let keyToTest = api_key;
      if (connection_id && !api_key) {
        const connections = await getProviderConnections({ provider: "openvecta" });
        const conn = connections.find(c => c.id === connection_id);
        if (!conn) {
          return res.status(404).json({ error: "Connection not found" });
        }
        keyToTest = conn.apiKey;
      }

      if (!keyToTest) {
        return res.status(400).json({ error: "api_key or connection_id is required" });
      }

      try {
        const testRes = await fetch("https://api.openvecta.com/v1/models", {
          headers: {
            "Authorization": `Bearer ${keyToTest}`,
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(15000),
        });

        if (testRes.ok) {
          const data = await testRes.json() as any;
          const models = data.data || data.models || [];
          // Update connection status
          if (connection_id) {
            await updateProviderConnection(connection_id, {
              testStatus: "active",
              lastTested: new Date().toISOString(),
              lastError: null,
            });
          }
          return res.json({
            ok: true,
            status: "active",
            models_count: models.length,
            message: `✓ Koneksi aktif. ${models.length} model tersedia.`,
          });
        } else {
          const errText = await testRes.text().catch(() => "");
          const errMsg = `HTTP ${testRes.status}: ${errText.substring(0, 200)}`;
          if (connection_id) {
            await updateProviderConnection(connection_id, {
              testStatus: "error",
              lastTested: new Date().toISOString(),
              lastError: errMsg,
            });
          }
          return res.json({ ok: false, status: "error", error: errMsg });
        }
      } catch (err) {
        const errMsg = err.message || String(err);
        if (connection_id) {
          await updateProviderConnection(connection_id, {
            testStatus: "error",
            lastTested: new Date().toISOString(),
            lastError: errMsg,
          });
        }
        return res.json({ ok: false, status: "error", error: errMsg });
      }
    }

    // ── Action: Cleanup old connections (>7 days) ─────────────────────────
    if (action === "cleanup-old") {
      const connections = await getProviderConnections({ provider: "openvecta" });
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      let deleted = 0;

      for (const conn of connections) {
        const createdAt = conn.createdAt ? new Date(conn.createdAt).getTime() : 0;
        if (createdAt > 0 && createdAt < sevenDaysAgo) {
          try {
            await deleteProviderConnection(conn.id);
            deleted++;
            console.log(`[openvecta-cleanup] Deleted old connection: ${conn.id} (created: ${conn.createdAt})`);
          } catch (e) {
            console.error(`[openvecta-cleanup] Failed to delete ${conn.id}:`, e);
          }
        }
      }

      return res.json({
        ok: true,
        deleted,
        total: connections.length,
        message: deleted > 0
          ? `✓ ${deleted} koneksi OpenVecta yang berusia >7 hari telah dihapus.`
          : "Tidak ada koneksi yang perlu dihapus.",
      });
    }

    // ── Action: Stop active job ───────────────────────────────────────────
    if (action === "stop") {
      const busy = global._openvectaState.activeJobId;
      if (!busy) {
        return res.json({ ok: true, message: "Tidak ada job aktif." });
      }

      global._openvectaState.stopFlag = true;

      if (global._openvectaState.activeProcesses) {
        for (const child of global._openvectaState.activeProcesses) {
          try {
            child.kill("SIGTERM");
          } catch (err) {
            console.error("Failed to kill child process:", err);
          }
        }
        global._openvectaState.activeProcesses.clear();
      }

      return res.json({
        ok: true,
        active_job_id: busy,
        message: "Stop signal terkirim.",
      });
    }

    // ── Action: Add existing API key manually ─────────────────────────────
    if (action === "add-key") {
      const { api_key, name } = body;
      if (!api_key || !api_key.startsWith("ov_sk_")) {
        return res.status(400).json({ error: "API key harus diawali dengan ov_sk_" });
      }

      // Check if key already exists
      const existing = await getProviderConnections({ provider: "openvecta" });
      const duplicate = existing.find(c => c.apiKey === api_key);
      if (duplicate) {
        return res.status(409).json({ error: "API key sudah terdaftar." });
      }

      const conn = await createProviderConnection({
        provider: "openvecta",
        authType: "apikey",
        name: name || `OpenVecta (${api_key.substring(0, 20)}...)`,
        apiKey: api_key,
        email: "",
        priority: 1,
        isActive: true,
        testStatus: "unknown",
      });

      return res.json({ ok: true, connection: conn });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (error) {
    console.error("Error in POST /api/automation/openvecta:", error);
    return res.status(500).json({ error: error.message });
  }
}

// ── Background runner ─────────────────────────────────────────────────────────
async function runOpenVectaSignup(jobId, email, venvPython, args) {
  try {
    const logDir = path.join(process.env.DATA_DIR || path.join(process.env.HOME || "/tmp", ".fsrouter"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      `${logDir}/automation_spawn.log`,
      `[${new Date().toISOString()}] openvecta spawning python: ${venvPython} ${args.join(" ")}\n`
    );
  } catch (err) {
    console.error("Failed to write to automation_spawn.log:", err);
  }

  const child = spawn(venvPython, args, {
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ":1" },
  });

  if (global._openvectaState.activeProcesses) {
    global._openvectaState.activeProcesses.add(child);
  }

  let stderrAccumulator = "";
  let lastStep = "Browser diluncurkan...";
  let done = false;

  child.stderr.on("data", (data) => {
    console.error(`[openvecta child stderr] ${data.toString()}`);
    stderrAccumulator += data.toString();
  });

  child.stdout.on("data", async (data) => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.step) {
          lastStep = parsed.step;
          console.log(`[openvecta] ${lastStep}`);
        } else if (parsed.status === "success") {
          done = true;
          const apiKey = parsed.api_key;
          console.log(`[openvecta] Success! API key: ${apiKey?.substring(0, 20)}...`);

          // Create provider connection
          try {
            await createProviderConnection({
              provider: "openvecta",
              authType: "apikey",
              name: email || `OpenVecta (${apiKey?.substring(0, 20)}...)`,
              apiKey: apiKey,
              email: email || "",
              priority: 1,
              isActive: true,
              testStatus: "active",
            });
            console.log(`[openvecta] Provider connection created for ${email}`);
          } catch (e) {
            console.error("[openvecta] Failed to create provider connection:", e);
          }
        } else if (parsed.status === "error") {
          done = true;
          console.error(`[openvecta] Error: ${parsed.error}`);
        }
      } catch (e) {
        // ignore non-JSON lines
      }
    }
  });

  child.on("close", async (code) => {
    if (global._openvectaState.activeProcesses) {
      global._openvectaState.activeProcesses.delete(child);
    }
    if (!done) {
      const errMsg = global._openvectaState.stopFlag
        ? "Dihentikan oleh pengguna."
        : `Proses terhenti dengan exit code ${code}.`;
      console.error(`[openvecta] ${errMsg} | Stderr: ${stderrAccumulator.trim()}`);
    }
    global._openvectaState.activeJobId = null;
    console.log(`[openvecta] Job ${jobId} finished.`);
  });

  child.on("error", async (err) => {
    if (global._openvectaState.activeProcesses) {
      global._openvectaState.activeProcesses.delete(child);
    }
    console.error(`[openvecta] Process error: ${err.message}`);
    global._openvectaState.activeJobId = null;
  });
}
