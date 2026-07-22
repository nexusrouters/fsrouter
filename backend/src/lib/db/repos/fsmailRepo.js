// fsmailRepo — CRUD untuk tabel fsmailConnections.
// Menyimpan konfigurasi koneksi Fsmail (endpoint + apiKey + field CF pendukung)
// sehingga kode lain tinggal memanggil getActiveFsmailConnection() tanpa
// hardcode dari settings blob.
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

function rowToConn(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    apiKey: row.apiKey,
    defaultDomain: row.defaultDomain,
    fallbackUrl: row.fallbackUrl,
    webhookSecret: row.webhookSecret,
    cfAccountId: row.cfAccountId,
    cfApiToken: row.cfApiToken,
    cfDomain: row.cfDomain,
    cfTelegramBotToken: row.cfTelegramBotToken,
    isActive: row.isActive === 1 || row.isActive === true,
    lastStatus: row.lastStatus,
    lastError: row.lastError,
    lastCheckedAt: row.lastCheckedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function connToRow(c) {
  return {
    id: c.id || uuidv4(),
    name: c.name,
    baseUrl: c.baseUrl,
    apiKey: c.apiKey,
    defaultDomain: c.defaultDomain ?? null,
    fallbackUrl: c.fallbackUrl ?? null,
    webhookSecret: c.webhookSecret ?? null,
    cfAccountId: c.cfAccountId ?? null,
    cfApiToken: c.cfApiToken ?? null,
    cfDomain: c.cfDomain ?? null,
    cfTelegramBotToken: c.cfTelegramBotToken ?? null,
    isActive: c.isActive === false ? 0 : 1,
    lastStatus: c.lastStatus ?? null,
    lastError: c.lastError ?? null,
    lastCheckedAt: c.lastCheckedAt ?? null,
    createdAt: c.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function listFsmailConnections() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM fsmailConnections ORDER BY isActive DESC, updatedAt DESC`);
  return rows.map(rowToConn);
}

export async function getFsmailConnection(id) {
  const db = await getAdapter();
  return rowToConn(db.get(`SELECT * FROM fsmailConnections WHERE id = ?`, id));
}

export async function getActiveFsmailConnection() {
  const db = await getAdapter();
  // prioritas: koneksi isActive=1 paling baru diupdate
  const row = db.get(`SELECT * FROM fsmailConnections WHERE isActive = 1 ORDER BY updatedAt DESC LIMIT 1`);
  return rowToConn(row);
}

export async function saveFsmailConnection(conn) {
  const db = await getAdapter();
  const r = connToRow(conn);
  db.run(
    `INSERT INTO fsmailConnections(
       id, name, baseUrl, apiKey, defaultDomain, fallbackUrl, webhookSecret,
       cfAccountId, cfApiToken, cfDomain, cfTelegramBotToken,
       isActive, lastStatus, lastError, lastCheckedAt, createdAt, updatedAt
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, baseUrl=excluded.baseUrl, apiKey=excluded.apiKey,
       defaultDomain=excluded.defaultDomain, fallbackUrl=excluded.fallbackUrl,
       webhookSecret=excluded.webhookSecret, cfAccountId=excluded.cfAccountId,
       cfApiToken=excluded.cfApiToken, cfDomain=excluded.cfDomain,
       cfTelegramBotToken=excluded.cfTelegramBotToken, isActive=excluded.isActive,
       lastStatus=excluded.lastStatus, lastError=excluded.lastError,
       lastCheckedAt=excluded.lastCheckedAt, updatedAt=excluded.updatedAt`,
    [
      r.id, r.name, r.baseUrl, r.apiKey, r.defaultDomain, r.fallbackUrl, r.webhookSecret,
      r.cfAccountId, r.cfApiToken, r.cfDomain, r.cfTelegramBotToken,
      r.isActive, r.lastStatus, r.lastError, r.lastCheckedAt, r.createdAt, r.updatedAt,
    ]
  );
  return r.id;
}

export async function deleteFsmailConnection(id) {
  const db = await getAdapter();
  db.run(`DELETE FROM fsmailConnections WHERE id = ?`, id);
}

// Test koneksi: ping endpoint /api/inboxes pakai apiKey.
// Mengembalikan { ok, status, error }.
export async function testFsmailConnection(conn) {
  const base = (conn.baseUrl || "").replace(/\/+$/, "");
  const url = `${base}/api/inboxes`;
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${conn.apiKey}` },
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, status: 0, error: (e && e.message) || String(e) };
  } finally {
    clearTimeout(to);
  }
}
