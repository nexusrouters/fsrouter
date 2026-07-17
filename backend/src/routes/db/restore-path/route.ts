import fs from "fs";
import { runRestoreStream } from "../../../lib/db/restoreRunner.js";

export const dynamic = "force-dynamic";

// POST /api/db/restore-path - Restore from a file path on the server itself
// (e.g. user pasted C:\Users\fud\backups\fsrouter-backup.fud, or a raw .sqlite)
export async function POST(req: any, res: any) {
  const { path: filePath } = req.body || {};
  if (!filePath || typeof filePath !== "string") {
    return res.status(400).json({ error: "Field 'path' wajib diisi." });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `File tidak ditemukan: ${filePath}` });
  }

  let body;
  try {
    if (filePath.endsWith(".sqlite")) {
      const b64 = fs.readFileSync(filePath).toString("base64");
      body = { signature: "FUDROUTER_BACKUP", version: 1, files: { "db/data.sqlite": b64 } };
    } else {
      body = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch (e: any) {
    return res.status(400).json({ error: "Gagal membaca/mem-parse file: " + e.message });
  }

  runRestoreStream(res, body);
}
