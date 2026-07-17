import fs from "node:fs";
import path from "path";
import os from "os";

const APP_NAME = "fsrouter";
const LEGACY_APP_NAME = "amrouter";

function defaultDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }
  return path.join(os.homedir(), `.${APP_NAME}`);
}

function legacyDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), LEGACY_APP_NAME);
  }
  return path.join(os.homedir(), `.${LEGACY_APP_NAME}`);
}

export function getDataDir() {
  const configured = process.env.DATA_DIR;
  if (configured) {
    try {
      fs.mkdirSync(configured, { recursive: true });
      return configured;
    } catch (e) {
      if (e?.code === "EACCES" || e?.code === "EPERM") {
        console.warn(`[DATA_DIR] '${configured}' not writable → fallback ~/.${APP_NAME}`);
        return defaultDir();
      }
      throw e;
    }
  }
  const dir = defaultDir();
  // Backward-compat: if the new dir doesn't exist yet but the legacy `amrouter`
  // dir does, migrate it (rename) so existing data isn't lost on first launch.
  if (!fs.existsSync(dir)) {
    const old = legacyDir();
    if (fs.existsSync(old)) {
      try {
        fs.renameSync(old, dir);
        console.log(`[DATA_DIR] Migrated legacy data folder ${old} → ${dir}`);
      } catch (e) {
        console.warn(`[DATA_DIR] Could not migrate ${old} → ${dir}: ${e.message}`);
      }
    }
  }
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}

export const DATA_DIR = getDataDir();
