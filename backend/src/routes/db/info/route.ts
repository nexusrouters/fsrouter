import { DATA_DIR } from "../../../lib/dataDir.js";
import path from "path";
import os from "os";

export const dynamic = "force-dynamic";

// GET /api/db/info - expose the detected data directory + a sensible default
// backup-path placeholder so the client doesn't hardcode OS-specific paths.
export async function GET(req: any, res: any) {
  const platform = process.platform; // 'win32' | 'linux' | 'darwin'
  const home = os.homedir();
  // Default folder where backups live / should be dropped.
  const defaultBackupDir = path.join(DATA_DIR, "backups");
  // A full example path (filename included) for the placeholder.
  const examplePath = path.join(defaultBackupDir, "fsrouter-backup.fud");
  res.json({
    platform,
    isWindows: platform === "win32",
    home,
    dataDir: DATA_DIR,
    defaultBackupDir,
    examplePath
  });
}
