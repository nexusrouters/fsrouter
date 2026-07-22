// /api/automation/fsmail/connections
// CRUD koneksi Fsmail + test koneksi (ping endpoint via apiKey).
import {
  listFsmailConnections,
  saveFsmailConnection,
  deleteFsmailConnection,
  testFsmailConnection,
} from "../../../../lib/db/repos/fsmailRepo.js";

export const dynamic = "force-dynamic";

export async function GET_handler(req, res) {
  try {
    const conns = await listFsmailConnections();
    // redact apiKey di response
    const safe = conns.map((c) => ({ ...c, apiKey: c.apiKey ? "***" + c.apiKey.slice(-4) : "" }));
    return res.json({ ok: true, connections: safe });
  } catch (e) {
    return res.status(500).json({ ok: false, error: (e as Error).message });
  }
}

export async function POST_handler(req, res) {
  try {
    const body = (req.body && typeof req.body === "object") ? req.body : await req.json?.().catch(() => ({})) || {};
    if (!body.baseUrl || !body.apiKey) {
      return res.status(400).json({ ok: false, error: "baseUrl & apiKey required" });
    }
    const id = await saveFsmailConnection({
      id: body.id || undefined,
      name: body.name || body.baseUrl,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
      defaultDomain: body.defaultDomain,
      fallbackUrl: body.fallbackUrl,
      webhookSecret: body.webhookSecret,
      cfAccountId: body.cfAccountId,
      cfApiToken: body.cfApiToken,
      cfDomain: body.cfDomain,
      cfTelegramBotToken: body.cfTelegramBotToken,
      isActive: body.isActive === false ? false : true,
    });
    // bila ada flag test, jalankan test koneksi langsung dari body config
    let test = null;
    if (body.test) {
      const { testFsmailConnection } = await import("../../../../lib/db/repos/fsmailRepo.js");
      test = await testFsmailConnection({
        baseUrl: body.baseUrl,
        apiKey: body.apiKey,
        defaultDomain: body.defaultDomain,
      });
      await saveFsmailConnection({
        id,
        name: body.name || body.baseUrl,
        baseUrl: body.baseUrl,
        apiKey: body.apiKey,
        defaultDomain: body.defaultDomain,
        fallbackUrl: body.fallbackUrl,
        webhookSecret: body.webhookSecret,
        cfAccountId: body.cfAccountId,
        cfApiToken: body.cfApiToken,
        cfDomain: body.cfDomain,
        cfTelegramBotToken: body.cfTelegramBotToken,
        isActive: body.isActive === false ? false : true,
        lastStatus: test.ok ? "ok" : "fail",
        lastError: test.error,
        lastCheckedAt: Date.now(),
      });
    }
    return res.json({ ok: true, id, test });
  } catch (e) {
    return res.status(500).json({ ok: false, error: (e as Error).message });
  }
}

export async function DELETE_handler(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    const id = url.searchParams.get("id");
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    await deleteFsmailConnection(id);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: (e as Error).message });
  }
}
