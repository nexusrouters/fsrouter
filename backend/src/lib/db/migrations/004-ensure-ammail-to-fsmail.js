// Migration 004 — ensure ammail* -> fsmail* rename is fully applied.
// Some installs (e.g. upgraded from 9Router / older builds) may still have
// the legacy `ammailAlias` column or `ammailOtps` table if migration 003 did
// not run. This makes the rename idempotent and safe to re-run.
export default {
  version: 4,
  name: "ensure-ammail-to-fsmail",
  up(db) {
    // 1. Rename table ammailOtps -> fsmailOtps if still present
    try {
      const tableExists = db.get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='ammailOtps'"
      );
      if (tableExists) {
        db.exec("ALTER TABLE ammailOtps RENAME TO fsmailOtps");
        console.log("[Migration 004] Renamed ammailOtps table to fsmailOtps");
      }
    } catch (e) {
      console.warn("[Migration 004] Failed to rename table ammailOtps:", e.message);
    }

    // 2. Rename column ammailAlias -> fsmailAlias in codebuddyAccounts if present
    try {
      const hasColumn = db.get(
        "SELECT 1 FROM pragma_table_info('codebuddyAccounts') WHERE name='ammailAlias'"
      );
      if (hasColumn) {
        db.exec("ALTER TABLE codebuddyAccounts RENAME COLUMN ammailAlias TO fsmailAlias");
        console.log("[Migration 004] Renamed ammailAlias column to fsmailAlias in codebuddyAccounts");
      }
    } catch (e) {
      console.warn("[Migration 004] Failed to rename column ammailAlias:", e.message);
    }

    // 3. Normalize settings JSON keys ammail_* -> fsmail_*
    try {
      const row = db.get("SELECT data FROM settings WHERE id = 1");
      if (row && row.data) {
        const settings = JSON.parse(row.data);
        let changed = false;
        const newSettings = {};
        for (const [key, value] of Object.entries(settings)) {
          if (key.startsWith("ammail_")) {
            const newKey = key.replace("ammail_", "fsmail_");
            newSettings[newKey] = value;
            changed = true;
          } else {
            newSettings[key] = value;
          }
        }
        if (changed) {
          db.run("UPDATE settings SET data = ? WHERE id = 1", [JSON.stringify(newSettings)]);
          console.log("[Migration 004] Normalized ammail_* settings keys to fsmail_*");
        }
      }
    } catch (e) {
      console.warn("[Migration 004] Failed to normalize settings keys:", e.message);
    }
  },
};
