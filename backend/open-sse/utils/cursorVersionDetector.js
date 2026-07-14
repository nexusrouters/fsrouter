import { homedir } from "os";
import { join } from "path";
import { createRequire } from "module";
const CACHE_TTL_MS = 60 * 60 * 1e3;
const DB_KEY = "cursorupdate.lastUpdatedAndShown.version";
const FALLBACK_VERSION = "3.9";
let cachedVersion = null;
let cachedAt = 0;
function getCursorDbPath() {
  if (process.env.CURSOR_STATE_DB_PATH) {
    return process.env.CURSOR_STATE_DB_PATH;
  }
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const platform = process.platform;
  if (platform === "darwin") {
    return join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb");
  }
  if (platform === "win32") {
    return join(process.env.APPDATA || home, "Cursor/User/globalStorage/state.vscdb");
  }
  return join(home, ".config/Cursor/User/globalStorage/state.vscdb");
}
function getCursorVersion() {
  const now = Date.now();
  if (cachedVersion && now - cachedAt < CACHE_TTL_MS) {
    return cachedVersion;
  }
  try {
    const esmRequire = createRequire(import.meta.url);
    const Database = esmRequire("better-sqlite3");
    const db = new Database(getCursorDbPath(), { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT value FROM itemTable WHERE key = ?").get(DB_KEY);
      if (row?.value) {
        cachedVersion = row.value;
        cachedAt = now;
        return cachedVersion;
      }
    } finally {
      db.close();
    }
  } catch {
  }
  return FALLBACK_VERSION;
}
function resetCursorVersionCache() {
  cachedVersion = null;
  cachedAt = 0;
}
export {
  FALLBACK_VERSION,
  getCursorDbPath,
  getCursorVersion,
  resetCursorVersionCache
};
