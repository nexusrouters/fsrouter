import { getAdapter } from "../../../lib/db/driver.js";
import { DATA_DIR } from "../../../lib/dataDir.js";
import path from "path";
import fs from "fs";

export const dynamic = "force-dynamic";

// GET /api/db/raw - Backup the raw SQLite database file (copy as-is)
export async function GET(req: any, res: any) {
  try {
    const db = await getAdapter();
    // Flush WAL into the main file so the copied .sqlite is self-contained.
    if (db && typeof db.checkpoint === "function") {
      try { db.checkpoint(); } catch { /* ignore */ }
    }
    if (db && typeof db.exec === "function") {
      try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* ignore */ }
    }
    const sqlitePath = path.join(DATA_DIR, "db", "data.sqlite");
    if (!fs.existsSync(sqlitePath)) {
      return res.status(404).json({ error: "Database file not found." });
    }
    res.setHeader("Content-Disposition", 'attachment; filename="fsrouter-db-raw.sqlite"');
    res.setHeader("Content-Type", "application/octet-stream");
    const stat = fs.statSync(sqlitePath);
    res.setHeader("Content-Length", stat.size);
    const stream = fs.createReadStream(sqlitePath);
    stream.on("error", (e) => { console.error("Raw backup stream error:", e); });
    stream.pipe(res);
  } catch (error: any) {
    console.error("Raw backup error:", error);
    if (!res.headersSent) res.status(500).json({ error: "Failed to generate raw backup: " + error.message });
  }
}
