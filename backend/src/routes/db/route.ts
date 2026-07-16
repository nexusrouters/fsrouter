import { getAdapter } from "../../lib/db/driver.js";
import { exportDb, importDb } from "../../lib/db/index.js";
import { DATA_DIR } from "../../lib/dataDir.js";
import path from "path";
import fs from "fs";

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

// POST /api/db - Restore database & secrets
export async function POST_handler(req: any, res: any) {
  try {
    const body = req.body;
    
    if (!body || body.signature !== "FUDROUTER_BACKUP") {
      return res.status(400).json({ error: "Invalid backup file signature." });
    }

    // Prefer logical import: raw SQLite replacement can lose rows when WAL/driver
    // state differs between machines. Keep raw-file restore below for old backups.
    if (body.database) {
      await importDb(body.database);
    } else {
      const db = await getAdapter();
      if (db && typeof db.close === "function") db.close();
    }

    // 2. Remove active -wal and -shm files to prevent corruption/mismatch
    const walFile = path.join(DATA_DIR, "db", "data.sqlite-wal");
    const shmFile = path.join(DATA_DIR, "db", "data.sqlite-shm");
    if (fs.existsSync(walFile)) fs.unlinkSync(walFile);
    if (fs.existsSync(shmFile)) fs.unlinkSync(shmFile);

    // 3. Restore secrets/raw DB only for legacy backups. Do not overwrite the
    // logical import with a stale/incompatible SQLite file.
    const filesToRestore = [
      { key: "db/data.sqlite", path: path.join(DATA_DIR, "db", "data.sqlite") },
      { key: "machine-id", path: path.join(DATA_DIR, "machine-id") },
      { key: "jwt-secret", path: path.join(DATA_DIR, "jwt-secret") },
      { key: "auth/cli-secret", path: path.join(DATA_DIR, "auth", "cli-secret") }
    ];

    for (const item of filesToRestore) {
      if (body.database && item.key === "db/data.sqlite") continue;
      const b64Data = body.files?.[item.key];
      if (b64Data) {
        // Ensure directory exists
        const dir = path.dirname(item.path);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        // Write file
        fs.writeFileSync(item.path, Buffer.from(b64Data, "base64"));
        console.log(`[Restore] Restored: ${item.key}`);
      }
    }

    // 4. Send success response and shut down process so PM2 restarts it
    res.json({ success: true, message: "Restore successful. Server is restarting..." });

    console.log("[Restore] Successful. Exiting process for restart...");
    setTimeout(() => {
      process.exit(0);
    }, 1500);

  } catch (error: any) {
    console.error("Restore error:", error);
    return res.status(500).json({ error: "Failed to restore backup: " + error.message });
  }
}
