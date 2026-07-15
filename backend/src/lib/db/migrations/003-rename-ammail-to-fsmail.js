export default {
  version: 3,
  name: "rename-ammail-to-fsmail",
  up(db) {
    // 1. Rename table ammailOtps to fsmailOtps if exists
    try {
      const tableExists = db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='ammailOtps'");
      if (tableExists) {
        db.exec("ALTER TABLE ammailOtps RENAME TO fsmailOtps");
        console.log("[Migration 003] Renamed ammailOtps table to fsmailOtps");
      }
    } catch (e) {
      console.warn("[Migration 003] Failed to rename table ammailOtps:", e.message);
    }

    // 2. Rename column ammailAlias to fsmailAlias in codebuddyAccounts
    try {
      const hasColumn = db.get("SELECT 1 FROM pragma_table_info('codebuddyAccounts') WHERE name='ammailAlias'");
      if (hasColumn) {
        db.exec("ALTER TABLE codebuddyAccounts RENAME COLUMN ammailAlias TO fsmailAlias");
        console.log("[Migration 003] Renamed ammailAlias column to fsmailAlias in codebuddyAccounts");
      }
    } catch (e) {
      console.warn("[Migration 003] Failed to rename column ammailAlias:", e.message);
    }

    // 3. Rename keys in settings table JSON data
    try {
      const row = db.get("SELECT data FROM settings WHERE id = 1");
      if (row && row.data) {
        const settings = JSON.parse(row.data);
        const newSettings = {};
        for (const [key, value] of Object.entries(settings)) {
          if (key.startsWith("ammail_")) {
            const newKey = key.replace("ammail_", "fsmail_");
            newSettings[newKey] = value;
          } else {
            newSettings[key] = value;
          }
        }
        db.run("UPDATE settings SET data = ? WHERE id = 1", [JSON.stringify(newSettings)]);
        console.log("[Migration 003] Migrated settings keys from ammail_* to fsmail_*");
      }
    } catch (e) {
      console.warn("[Migration 003] Failed to migrate settings keys:", e.message);
    }
  }
};
