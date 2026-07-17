// Recreate codebuddyAccounts table to drop the single-column UNIQUE(email)
// and replace it with composite UNIQUE(email, provider).
// Idempotent: handles both legacy `ammailAlias` and renamed `fsmailAlias`
// columns in the old table (older DBs may have run migration 003/004 before
// this migration's version was recorded, leaving `fsmailAlias` in _old).
export default {
  version: 2,
  name: "composite-unique-codebuddy-accounts",
  up(db) {
    // If the table doesn't exist at all, just create it fresh and bail.
    const exists = db.get(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='codebuddyAccounts'"
    );
    if (!exists) {
      db.exec(`
        CREATE TABLE codebuddyAccounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT NOT NULL,
          password TEXT NOT NULL,
          profileDir TEXT,
          fsmailAlias TEXT,
          signupMethod TEXT DEFAULT 'google',
          apiKey TEXT,
          apiKeyStatus TEXT DEFAULT 'pending',
          lastError TEXT,
          lastRunAt INTEGER,
          createdAt TEXT NOT NULL,
          provider TEXT DEFAULT 'codebuddy',
          canvaEnrolled INTEGER DEFAULT 0,
          UNIQUE(email, provider)
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_cba_email ON codebuddyAccounts(email)");
      return;
    }

    // Detect which alias column the existing (old) table uses.
    const info = db.all("PRAGMA table_info(codebuddyAccounts)");
    const cols = info.map((c) => c.name);
    const hasFsmail = cols.includes("fsmailAlias");
    const hasAmmail = cols.includes("ammailAlias");
    const oldAlias = hasFsmail ? "fsmailAlias" : hasAmmail ? "ammailAlias" : null;

    // Already on the target schema (composite unique + fsmailAlias) — skip.
    if (hasFsmail) {
      const idx = db.all(
        "SELECT 1 FROM sqlite_master WHERE type='index' AND name='sqlite_autoindex_codebuddyAccounts_1'"
      );
      // The composite UNIQUE was added by this migration; if it's already there, nothing to do.
      try {
        db.get("SELECT email, provider FROM codebuddyAccounts LIMIT 1");
      } catch { /* ignore */ }
      // If a composite index already exists we can safely skip.
      const compIdx = db.all(
        "SELECT * FROM sqlite_master WHERE type='index' AND tbl_name='codebuddyAccounts' AND sql LIKE '%email%provider%'"
      );
      if (compIdx.length > 0) return;
    }

    // 1. Rename existing table
    db.exec("ALTER TABLE codebuddyAccounts RENAME TO codebuddyAccounts_old");

    // 2. Create new table with unique(email, provider) constraint + fsmailAlias
    db.exec(`
      CREATE TABLE codebuddyAccounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        password TEXT NOT NULL,
        profileDir TEXT,
        fsmailAlias TEXT,
        signupMethod TEXT DEFAULT 'google',
        apiKey TEXT,
        apiKeyStatus TEXT DEFAULT 'pending',
        lastError TEXT,
        lastRunAt INTEGER,
        createdAt TEXT NOT NULL,
        provider TEXT DEFAULT 'codebuddy',
        canvaEnrolled INTEGER DEFAULT 0,
        UNIQUE(email, provider)
      )
    `);

    // 3. Recreate index
    db.exec("CREATE INDEX IF NOT EXISTS idx_cba_email ON codebuddyAccounts(email)");

    // 4. Copy data from old table, mapping whichever alias column exists.
    const aliasSelect = oldAlias || "NULL";
    db.exec(`
      INSERT OR IGNORE INTO codebuddyAccounts (
        id, email, password, profileDir, fsmailAlias, signupMethod,
        apiKey, apiKeyStatus, lastError, lastRunAt, createdAt, provider, canvaEnrolled
      )
      SELECT
        id, email, password, profileDir, ${aliasSelect}, signupMethod,
        apiKey, apiKeyStatus, lastError, lastRunAt, createdAt, provider, canvaEnrolled
      FROM codebuddyAccounts_old
    `);

    // 5. Drop old table
    db.exec("DROP TABLE codebuddyAccounts_old");
  }
};
