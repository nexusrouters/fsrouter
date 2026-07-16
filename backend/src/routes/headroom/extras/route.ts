import { getSettings } from "../../../lib/db/repos/settingsRepo.js";
import { findPython310, getInstalledHeadroomExtras, getHeadroomLogTail } from "../../../lib/headroom/detect.js";
import { installHeadroomExtras, uninstallHeadroomExtras } from "../../../lib/headroom/process.js";

export async function GET(req, res) {
  try {
    if (new URL(req.url, "http://x").searchParams.get("log") === "1") {
      const log = getHeadroomLogTail(15);
      return res.json({ log });
    }
    const python = findPython310();
    const status = getInstalledHeadroomExtras(python);
    return res.json(status);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

export async function POST(req, res) {
  try {
    const body = await req.json().catch(() => ({}));
    const extras = Array.isArray(body.extras) ? body.extras : [];
    if (extras.length === 0) {
      return res.status(400).json({ error: "No extras requested" });
    }
    const python = findPython310();
    if (!python) {
      return res.status(400).json({ error: "NO_PYTHON", message: "Python >= 3.10 required" });
    }
    const result = await installHeadroomExtras(extras);
    return res.json(result);
  } catch (e) {
    if (e.code === "INVALID_EXTRAS" || e.code === "NOT_INSTALLED") {
      return res.status(400).json({ error: e.code, message: e.message });
    }
    return res.status(500).json({ error: e.message });
  }
}

export async function DELETE(req, res) {
  try {
    const body = await req.json().catch(() => ({}));
    const extras = Array.isArray(body.extras) ? body.extras : [];
    if (extras.length === 0) {
      return res.status(400).json({ error: "No extras requested" });
    }
    const python = findPython310();
    if (!python) {
      return res.status(400).json({ error: "NO_PYTHON", message: "Python >= 3.10 required" });
    }
    const result = await uninstallHeadroomExtras(extras);
    return res.json(result);
  } catch (e) {
    if (e.code === "INVALID_EXTRAS" || e.code === "NOT_INSTALLED") {
      return res.status(400).json({ error: e.code, message: e.message });
    }
    return res.status(500).json({ error: e.message });
  }
}
