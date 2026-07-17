import { exportDb } from "../../lib/db/index.js";
import { getAdapter } from "../../lib/db/driver.js";
import { DATA_DIR } from "../../lib/dataDir.js";
import path from "path";
import fs from "fs";
import { runRestoreStream } from "../../lib/db/restoreRunner.js";
export const dynamic = "force-dynamic";

// GET /api/db - Backup database & secrets
export async function GET(req: any, res: any) {
  try {
    const db = await getAdapter();

    // 1. Clean up stale/large records (like old OTPs) to shrink backup
    if (db && typeof db.exec === "function") {
      try {
        const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
        db.run("DELETE FROM fsmailOtps WHERE receivedAt < ?", [threeDaysAgo]);
        // Vacuum to compress and physically shrink the .sqlite file
        db.exec("VACUUM");
      } catch (e) {
        console.error("Backup vacuum error:", e);
      }
    }

    // 2. Force WAL checkpoint to flush memory to disk
    if (db && typeof db.checkpoint === "function") {
      db.checkpoint();
    }

    const backupData: any = {
      signature: "FUDROUTER_BACKUP",
      version: 1,
      timestamp: new Date().toISOString(),
      // Logical export is portable across SQLite drivers/versions; raw DB remains
      // below for backward compatibility with older .fud files.
      database: await exportDb(),
      files: {}
    };

    const filesToBackup = [
      { key: "db/data.sqlite", path: path.join(DATA_DIR, "db", "data.sqlite") },
      { key: "machine-id", path: path.join(DATA_DIR, "machine-id") },
      { key: "jwt-secret", path: path.join(DATA_DIR, "jwt-secret") },
      { key: "auth/cli-secret", path: path.join(DATA_DIR, "auth", "cli-secret") }
    ];

    for (const item of filesToBackup) {
      if (fs.existsSync(item.path)) {
        const content = fs.readFileSync(item.path);
        backupData.files[item.key] = content.toString("base64");
      }
    }

    // Force download as a .fud file
    res.setHeader("Content-Disposition", 'attachment; filename="fsrouter-backup.fud"');
    res.setHeader("Content-Type", "application/octet-stream");
    return res.send(JSON.stringify(backupData, null, 2));

  } catch (error: any) {
    console.error("Backup error:", error);
    return res.status(500).json({ error: "Failed to generate backup: " + error.message });
  }
}

// ─── SSE helpers for streaming restore progress ───────────────────────────────

// POST /api/db - Restore database & secrets (streaming progress)
export async function POST_handler(req: any, res: any) {
  runRestoreStream(res, req.body);
}
