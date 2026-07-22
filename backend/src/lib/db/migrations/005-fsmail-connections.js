// Migration 005: tabel fsmailConnections + seed dari settings lama.
// Menyimpan konfigurasi koneksi Fsmail (endpoint + apiKey + field CF)
// agar kode lain bisa membaca koneksi aktif tanpa hardcode dari settings blob.
import { TABLES, buildCreateTableSql } from "../schema.js";

export default {
  version: 5,
  name: "fsmail-connections",
  up(db) {
    // 1) buat tabel bila belum ada
    db.exec(buildCreateTableSql("fsmailConnections", TABLES.fsmailConnections));
    for (const idx of TABLES.fsmailConnections.indexes || []) db.exec(idx);

    // 2) seed dari settings (bila ada & tabel masih kosong)
    const existing = db.get(`SELECT COUNT(*) AS c FROM fsmailConnections`);
    if (existing && existing.c > 0) return;

    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    if (!row || !row.data) return;
    let s;
    try { s = JSON.parse(row.data); } catch { return; }
    if (!s.fsmail_base_url || !s.fsmail_api_key) return;

    const now = new Date().toISOString();
    db.run(
      `INSERT OR IGNORE INTO fsmailConnections(
         id, name, baseUrl, apiKey, defaultDomain, fallbackUrl, webhookSecret,
         cfAccountId, cfApiToken, cfDomain, cfTelegramBotToken,
         isActive, createdAt, updatedAt
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        "seed-from-settings",
        "Fsmail (settings)",
        s.fsmail_base_url,
        s.fsmail_api_key,
        s.fsmail_default_domain || null,
        s.fsmail_cf_workers_dev_url || null,
        s.fsmail_webhook_secret || null,
        s.fsmail_cf_account_id || null,
        s.fsmail_cf_api_token || null,
        s.fsmail_cf_domain || null,
        s.fsmail_cf_telegram_bot_token || null,
        now,
        now,
      ]
    );
  },
};
