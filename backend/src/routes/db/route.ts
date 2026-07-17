import { getAdapter, resetAdapter } from "../../lib/db/driver.js";
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

// ─── SSE helpers for streaming restore progress ───────────────────────────────
function sseInit(res: any) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
}
function sseSend(res: any, event: string, data: any) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// POST /api/db - Restore database & secrets (streaming progress)
export async function POST_handler(req: any, res: any) {
  // Switch to SSE immediately so the client sees progress from the start.
  sseInit(res);
  const log = (msg: string, level: "info" | "warn" | "error" = "info") =>
    sseSend(res, "log", { message: msg, level, ts: new Date().toISOString() });
  const progress = (percent: number, label: string) => {
    sseSend(res, "progress", { percent, label });
    log(label);
  };

  // Run restore asynchronously; don't await the whole thing on the request.
  (async () => {
    try {
      const body = req.body;

      progress(5, "Memvalidasi file backup...");
      if (!body || body.signature !== "FUDROUTER_BACKUP") {
        sseSend(res, "error", { message: "Invalid backup file signature." });
        return res.end();
      }

      // Prefer logical import: raw SQLite replacement can lose rows when WAL/driver
      // state differs between machines. Keep raw-file restore below for old backups.
      const hasLogical = !!body.database;
      if (hasLogical) {
        progress(15, "Mengimpor data logical (provider, connections, proxy, api keys, combos)...");
        // Import on the live connection.
        await importDb(body.database);

        progress(40, "Flush WAL ke file database utama (checkpoint)...");
        const db = await getAdapter();
        if (db && typeof db.checkpoint === "function") {
          try { db.checkpoint(); } catch (e) { log(`checkpoint gagal: ${e.message}`, "warn"); }
        }
        if (db && typeof db.exec === "function") {
          try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* ignore */ }
        }

        progress(50, "Menutup koneksi DB agar file WAL/SHM tidak terkunci...");
        // Switch journal mode to DELETE so SQLite folds the WAL back into the
        // main db file and deletes -wal/-shm itself — avoids leaving a locked
        // WAL that Windows can't unlink (which previously dropped restored rows).
        if (db && typeof db.exec === "function") {
          try { db.exec("PRAGMA journal_mode=DELETE"); } catch { /* ignore */ }
        }
        // Close the connection so Windows releases the -wal/-shm file locks.
        // Logical data is already flushed to the main DB via the checkpoint above.
        if (db && typeof db.close === "function") {
          try { db.close(); } catch { /* ignore */ }
        }
        // Clear the cached instance so getAdapter() re-opens fresh on next boot.
        resetAdapter();
      } else {
        progress(15, "Menutup koneksi database aktif (raw restore)...");
        const db = await getAdapter();
        if (db && typeof db.close === "function") {
          try { db.close(); } catch { /* ignore */ }
        }
        // Reset cached instance so the next getAdapter() re-opens a fresh connection.
        resetAdapter();
      }

      // 2. Remove active -wal and -shm files to prevent corruption/mismatch.
      progress(50, "Membersihkan file WAL/SHM lock...");
      const walFile = path.join(DATA_DIR, "db", "data.sqlite-wal");
      const shmFile = path.join(DATA_DIR, "db", "data.sqlite-shm");

      const safeUnlink = (file: string) => {
        if (!fs.existsSync(file)) return;
        const attempts = process.platform === "win32" ? 12 : 3;
        for (let i = 0; i < attempts; i++) {
          try {
            fs.unlinkSync(file);
            return;
          } catch (e: any) {
            if (e.code === "EBUSY" || e.code === "EPERM" || e.code === "ETXTBSY") {
              try {
                const tmp = `${file}.old-${Date.now()}`;
                fs.renameSync(file, tmp);
                try { fs.unlinkSync(tmp); } catch { /* ignore */ }
                return;
              } catch {
                try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250); } catch { /* noop */ }
                continue;
              }
            }
            throw e;
          }
        }
        log(`Tidak bisa menghapus ${file} (terkunci) — melanjutkan.`, "warn");
      };
      safeUnlink(walFile);
      safeUnlink(shmFile);

      // 3. Restore secrets/raw DB only for legacy backups. Do not overwrite the
      // logical import with a stale/incompatible SQLite file.
      const filesToRestore = [
        { key: "db/data.sqlite", path: path.join(DATA_DIR, "db", "data.sqlite") },
        { key: "machine-id", path: path.join(DATA_DIR, "machine-id") },
        { key: "jwt-secret", path: path.join(DATA_DIR, "jwt-secret") },
        { key: "auth/cli-secret", path: path.join(DATA_DIR, "auth", "cli-secret") }
      ];

      let idx = 0;
      const total = filesToRestore.length;
      for (const item of filesToRestore) {
        if (hasLogical && item.key === "db/data.sqlite") {
          idx++;
          continue; // logical import already applied the DB
        }
        const b64Data = body.files?.[item.key];
        const pct = 60 + Math.round((idx / total) * 35);
        if (b64Data) {
          progress(pct, `Menimpa file: ${item.key} ...`);
          const dir = path.dirname(item.path);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(item.path, Buffer.from(b64Data, "base64"));
          log(`✓ Di-timpa: ${item.key}`, "info");
        } else {
          log(`Lewati (tidak ada di backup): ${item.key}`, "warn");
        }
        idx++;
      }

      progress(100, "Restore selesai. Server akan merestart...");
      sseSend(res, "done", { success: true, message: "Restore berhasil. Server merestart..." });

      // 4. Shut down process so PM2 restarts it (applies restored data cleanly)
      setTimeout(() => {
        try { process.exit(0); } catch { /* ignore */ }
      }, 1200);
    } catch (error: any) {
      console.error("Restore error:", error);
      sseSend(res, "error", { message: "Restore gagal: " + (error?.message || error) });
      res.end();
    }
  })();
}
