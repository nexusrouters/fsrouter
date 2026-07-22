// Fsmail connection module — mandiri, bisa di-import kode lain.
// Koneksi ke Fsmail via apiKey + endpoint (baseUrl).
// Field koneksi disimpan di tabel fsmailConnections (lihat fsmailRepo).
import { getActiveFsmailConnection, getFsmailConnection, testFsmailConnection } from "../db/repos/fsmailRepo.js";
import { getSettings } from "../localDb.js";

export interface FsmailConnConfig {
  id?: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultDomain?: string;
  fallbackUrl?: string;
  webhookSecret?: string;
  cfAccountId?: string;
  cfApiToken?: string;
  cfDomain?: string;
  cfTelegramBotToken?: string;
}

function normUrl(u: string): string {
  let s = (u || "").trim().replace(/\/+$/, "");
  if (s && !/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s;
}

// Koneksi aktif. Prioritas: tabel fsmailConnections (isActive).
// Fallback: settings lama (fsmail_base_url / fsmail_api_key) agar kompatibel.
export async function resolveActiveFsmail(): Promise<FsmailConnConfig | null> {
  const fromTable = await getActiveFsmailConnection();
  if (fromTable && fromTable.baseUrl && fromTable.apiKey) return fromTable;
  // fallback ke settings
  const s = await getSettings();
  if (s.fsmail_base_url && s.fsmail_api_key) {
    return {
      name: "from-settings",
      baseUrl: s.fsmail_base_url,
      apiKey: s.fsmail_api_key,
      defaultDomain: s.fsmail_default_domain,
      fallbackUrl: s.fsmail_cf_workers_dev_url,
      webhookSecret: s.fsmail_webhook_secret,
      cfAccountId: s.fsmail_cf_account_id,
      cfApiToken: s.fsmail_cf_api_token,
      cfDomain: s.fsmail_cf_domain,
      cfTelegramBotToken: s.fsmail_cf_telegram_bot_token,
    };
  }
  return null;
}

export class FsmailApi {
  baseUrl: string;
  apiKey: string;
  defaultDomain: string;
  fallbackUrl: string;
  constructor(cfg: FsmailConnConfig) {
    this.baseUrl = normUrl(cfg.baseUrl);
    this.apiKey = (cfg.apiKey || "").trim();
    this.defaultDomain = (cfg.defaultDomain || "").toLowerCase();
    this.fallbackUrl = normUrl(cfg.fallbackUrl || "");
  }
  get configured(): boolean {
    return !!this.baseUrl && !!this.apiKey;
  }
  private async req(method: string, path: string, body?: any): Promise<any> {
    if (!this.configured) throw new Error("fsmail_not_configured");
    const tryOnce = async (base: string) => {
      const url = `${base}${path}`;
      const headers: any = { Accept: "application/json", Authorization: `Bearer ${this.apiKey}` };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
      const text = await res.text();
      let data: any = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (!res.ok) throw new Error(`fsmail ${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
      return data;
    };
    try {
      return await tryOnce(this.baseUrl);
    } catch (e) {
      if (this.fallbackUrl && this.fallbackUrl !== this.baseUrl) {
        return await tryOnce(this.fallbackUrl);
      }
      throw e;
    }
  }
  async createInbox(alias?: string, domain?: string): Promise<{ address: string; alias: string }> {
    const body: any = {};
    if (alias) body.alias = alias.toLowerCase();
    if (domain || this.defaultDomain) body.domain = (domain || this.defaultDomain);
    const data = await this.req("POST", "/api/inboxes", body);
    if (!data?.inbox?.address) throw new Error("fsmail createInbox: no address");
    return { address: data.inbox.address, alias: data.inbox.alias || data.inbox.address.split("@")[0] };
  }
  async listMessages(alias: string): Promise<any[]> {
    const data = await this.req("GET", `/api/inboxes/${alias.trim().toLowerCase()}/messages`);
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.messages)) return data.messages;
    if (Array.isArray(data?.data)) return data.data;
    return [];
  }
  async getMessage(alias: string, messageId: string): Promise<any> {
    return await this.req("GET", `/api/inboxes/${alias.trim().toLowerCase()}/messages/${messageId}`);
  }
  // Pastikan inbox ada (buat bila belum). Abaikan error "already exists".
  async ensureInbox(address: string): Promise<void> {
    const alias = address.split("@")[0].toLowerCase();
    try {
      await this.req("POST", "/api/inboxes", { alias, domain: this.defaultDomain || undefined });
    } catch (e: any) {
      const m = e?.message || "";
      if (!/exist|409|conflict|already/i.test(m)) {
        console.warn(`[fsmail] ensureInbox warning: ${m.slice(0, 120)}`);
      }
    }
  }
}

// Helper: ambil koneksi aktif lalu bungkus jadi FsmailApi.
export async function getActiveFsmailApi(): Promise<FsmailApi | null> {
  const cfg = await resolveActiveFsmail();
  if (!cfg) return null;
  return new FsmailApi(cfg);
}

export { getFsmailConnection, testFsmailConnection };
