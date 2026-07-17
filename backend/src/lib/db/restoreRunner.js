import { getAdapter, resetAdapter } from "./driver.js";
import { importDb } from "./index.js";
import { DATA_DIR } from "../dataDir.js";
import path from "path";
import fs from "fs";

// Streaming restore runner shared by POST /api/db and POST /api/db/restore-path.
// Sends SSE events: progress {percent,label}, log {message,level}, error, done.
export function runRestoreStream(res, body) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  const sseSend = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const log = (msg, level = "info") => sseSend("log", { message: msg, level, ts: new Date().toISOString() });
  const progress = (percent, label) => {
    sseSend("progress", { percent, label });
    log(label);
  };

  (async () => {
    try {
      progress(5, "Memvalidasi file backup...");
      if (!body || body.signature !== "FUDROUTER_BACKUP") {
        sseSend("error", { message: "Invalid backup file signature." });
        return res.end();
      }

      const hasLogical = !!body.database;
      if (hasLogical) {
        progress(15, "Mengimpor data logical (provider, connections, proxy, api keys, combos, akun automation)...");
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
        if (db && typeof db.exec === "function") {
          try { db.exec("PRAGMA journal_mode=DELETE"); } catch { /* ignore */ }
        }
        if (db && typeof db.close === "function") {
          try { db.close(); } catch { /* ignore */ }
        }
        resetAdapter();
      } else {
        progress(15, "Menutup koneksi database aktif (raw restore)...");
        const db = await getAdapter();
        if (db && typeof db.close === "function") {
          try { db.close(); } catch { /* ignore */ }
        }
        resetAdapter();
      }

      progress(50, "Membersihkan file WAL/SHM lock...");
      const walFile = path.join(DATA_DIR, "db", "data.sqlite-wal");
      const shmFile = path.join(DATA_DIR, "db", "data.sqlite-shm");

      const safeUnlink = (file) => {
        if (!fs.existsSync(file)) return;
        const attempts = process.platform === "win32" ? 12 : 3;
        for (let i = 0; i < attempts; i++) {
          try {
            fs.unlinkSync(file);
            return;
          } catch (e) {
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
          continue;
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
      sseSend("done", { success: true, message: "Restore berhasil. Server merestart..." });

      setTimeout(() => {
        try { process.exit(0); } catch { /* ignore */ }
      }, 1200);
    } catch (error) {
      console.error("Restore error:", error);
      sseSend("error", { message: "Restore gagal: " + (error?.message || error) });
      res.end();
    }
  })();
}
