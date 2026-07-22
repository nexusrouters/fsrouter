#!/usr/bin/env node
// @ts-nocheck
/**
 * grok_cli_gac.ts — FSRouter Grok CLI (x.ai) auto-registrar.
 *
 * Port dari https://github.com/wanglinsaputra/GAC (WangLinS Grok Auto Creator)
 * yang diadaptasi ke FSRouter:
 *   - pakai puppeteer-core + system Chrome (bukan python/playwright)
 *   - decrypt ekstensi Turnstile ter-seal via SEAL_UNLOCK_URL/SEAL_TOKEN
 *   - email + OTP dipasok dari Fsmail FSRouter (bukan tempmail GAC)
 *   - fix multi-step login xAI (email -> Next -> password -> Turnstile -> submit)
 *   - tahap akhir: klik "Allow" di halaman device authorization, lalu serahkan
 *     device_code ke /api/oauth/grok-cli/poll di target router.
 *
 * Output: satu JSON object per baris ke stdout (progress UI FSRouter).
 *   {"step": N, "msg": "..."}
 *   {"done": true, "email": "..."}
 *   {"error": "..."}
 */
import puppeteer, { type Browser, type Cookie, type Page } from "puppeteer-core";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseKeyB64, parseSealedJson, unsealUtf8 } from "./seal-crypto.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/automation/grok_cli_gac.js  -> root = backend/
const ROOT = resolve(__dirname, "..", "..");
const ENC_DIR = join(ROOT, "src", "automation", "turnstilePatch");

// Browser globals dipakai di dalam page.evaluate() (konteks browser, bukan Node).
// FSRouter backend tsconfig tidak include "dom", jadi kita deklarasikan sebagai any.
declare const window: any;
declare const document: any;
declare const location: any;
declare const HTMLElement: any;

// ── arg parsing ────────────────────────────────────────────────────────────
function envOr(key: string, def = ""): string {
  const p = process.env[key]?.trim();
  if (p) return p;
  return def;
}

interface Args {
  email?: string;
  password: string;
  fsmailBaseUrl: string;
  fsmailApiKey: string;
  fsmailDomain: string;
  routerUrl: string;
  routerPassword: string;
  sealUnlockUrl: string;
  sealToken: string;
  headless: boolean;
  deviceCode: string;
  codeVerifier: string;
}

function parseArgs(): Args {
  const a: Record<string, string> = {};
  for (const tok of process.argv.slice(2)) {
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq >= 0) a[tok.slice(2, eq)] = tok.slice(eq + 1);
      else a[tok.slice(2)] = "true";
    }
  }
  return {
    email: a["email"],
    password: a["password"] || envOr("GROK_PASSWORD", `G${Math.random().toString(36).slice(2, 10)}k${Math.random().toString(36).slice(2, 10)}R`),
    fsmailBaseUrl: a["fsmail-base-url"] || envOr("FSMAIL_BASE_URL", ""),
    fsmailApiKey: a["fsmail-api-key"] || envOr("FSMAIL_API_KEY", ""),
    fsmailDomain: a["fsmail-domain"] || envOr("FSMAIL_DEFAULT_DOMAIN", ""),
    routerUrl: a["router-url"] || envOr("ROUTER_URL", "http://127.0.0.1:20128"),
    routerPassword: a["router-password"] || envOr("ROUTER_PASSWORD", ""),
    sealUnlockUrl: a["seal-unlock-url"] || envOr("SEAL_UNLOCK_URL", "https://wanglins.6n6.web.id"),
    sealToken: a["seal-token"] || envOr("SEAL_TOKEN", "e4k-0Dil5dKU82VlBLzp50AdWmWVPCdc"),
    headless: !/^(0|false|no)$/i.test(a["headless"] || envOr("HEADLESS", "true")),
    proxy: a["proxy"] || envOr("GROK_PROXY", ""),
    deviceCode: a["device-code"] || envOr("DEVICE_CODE", ""),
    codeVerifier: a["code-verifier"] || envOr("CODE_VERIFIER", ""),
  };
}

const log = (o: Record<string, unknown>) => process.stdout.write(JSON.stringify(o) + "\n");

// ── Fsmail (mirip fsmailClient.js, self-contained) ─────────────────────────
class Fsmail {
  base: string;
  key: string;
  domain: string;
  constructor(base: string, key: string, domain: string) {
    this.base = (base || "").trim().replace(/\/+$/, "");
    this.key = (key || "").trim();
    this.domain = (domain || "").trim().toLowerCase();
  }
  get ok() {
    return !!this.base && !!this.key;
  }
  async _req(method: string, path: string, body: any = null): Promise<any> {
    const url = `${this.base}${path}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.key}`, Accept: "application/json" };
    if (body !== null) headers["Content-Type"] = "application/json";
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    const txt = await res.text().catch(() => "");
    if (!res.ok) throw new Error(`fsmail ${method} ${path} -> ${res.status} ${txt.slice(0, 160)}`);
    try {
      return JSON.parse(txt);
    } catch {
      return {};
    }
  }
  async createInbox(): Promise<{ address: string; alias: string }> {
    const body: any = {};
    if (this.domain) body.domain = this.domain;
    const data = await this._req("POST", "/api/inboxes", body);
    if (!data?.inbox?.address) throw new Error("fsmail createInbox: no address");
    return { address: data.inbox.address, alias: data.inbox.alias || data.inbox.address.split("@")[0] };
  }
  // Pastikan inbox ada untuk email tertentu (buat bila belum ada).
  async ensureInbox(addr: string): Promise<void> {
    const alias = addr.split("@")[0].toLowerCase();
    try {
      await this._req("POST", "/api/inboxes", { alias, domain: this.domain || undefined });
    } catch (e) {
      // 409 / already exists -> oke, inbox memang sudah ada
      const m = (e as Error).message || "";
      if (!/exist|409|conflict|already/i.test(m)) {
        log({ step: 1, msg: `ensureInbox warning: ${m.slice(0, 120)}` });
      }
    }
  }
  async listMessages(alias: string): Promise<any[]> {
    const data = await this._req("GET", `/api/inboxes/${alias.trim().toLowerCase()}/messages`);
    return data.messages || [];
  }
  async readMessage(id: string): Promise<any> {
    return this._req("GET", `/api/messages/${id.trim()}`);
  }
}

function extractOtp(text: string): string | null {
  if (!text) return null;
  let g = text.match(/code:\s*([A-Z0-9]{3}-[A-Z0-9]{3})/i);
  if (g) return g[1].replace(/-/g, "");
  g = text.match(/code:\s*([A-Z0-9]{6})/i);
  if (g) return g[1];
  g = text.match(/\b([A-Z0-9]{3}-[A-Z0-9]{3})\b/i);
  if (g) return g[1].replace(/-/g, "");
  g = text.match(/\b([A-Z0-9]{6})\b/);
  if (g) return g[1];
  return null;
}

// ── Turnstile extension unseal (dari GAC seal-turnstile.ts) ─────────────────
const temps = new Set<string>();
function trackTemp(dir: string): string {
  temps.add(dir);
  return dir;
}
function cleanupSealedTemps() {
  for (const d of temps) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
  temps.clear();
}
process.once("exit", cleanupSealedTemps);

function materializeExt(scriptJs: string): string {
  const manifestPath = join(ENC_DIR, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`missing ${manifestPath}`);
  const dir = trackTemp(mkdtempSync(join(tmpdir(), "wls-turnstile-")));
  writeFileSync(join(dir, "script.js"), scriptJs, "utf8");
  writeFileSync(join(dir, "manifest.json"), readFileSync(manifestPath), "utf8");
  return dir;
}

async function fetchUnlockKey(kid: string, urlBase: string, token: string): Promise<string> {
  if (!urlBase) throw new Error("SEAL_UNLOCK_URL not configured");
  const u = new URL(urlBase);
  u.searchParams.set("kid", kid);
  u.searchParams.set("app", "wanglin-s-grok-signup");
  const res = await fetch(u, {
    method: "GET",
    headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`unlock HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  const data = (await res.json()) as { key?: string };
  if (!data?.key) throw new Error("unlock response missing key");
  return data.key;
}

async function resolveTurnstileExt(sealUnlockUrl: string, sealToken: string): Promise<string> {
  const plain = join(ENC_DIR, "script.js");
  const manifest = join(ENC_DIR, "manifest.json");
  if (existsSync(plain) && existsSync(manifest)) return ENC_DIR;
  const sealedPath = join(ENC_DIR, "script.sealed");
  if (!existsSync(sealedPath) || !existsSync(manifest)) {
    throw new Error(`missing turnstile assets (need script.js or script.sealed + manifest.json in ${ENC_DIR})`);
  }
  const blob = parseSealedJson(readFileSync(sealedPath, "utf8"));
  const localKey = process.env.SEAL_KEY?.trim();
  const keyBuf = localKey ? parseKeyB64(localKey) : parseKeyB64(await fetchUnlockKey(blob.kid || "default", sealUnlockUrl, sealToken));
  const scriptJs = unsealUtf8(blob, keyBuf);
  return materializeExt(scriptJs);
}

// ── Chrome / puppeteer helpers (dari GAC shared.ts) ─────────────────────────
function findChrome(): string {
  const cand = [
    envOr("CHROME_PATH"),
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ].filter(Boolean) as string[];
  for (const c of cand) if (existsSync(c)) return c;
  throw new Error("Chrome not found. Install Google Chrome or set CHROME_PATH");
}

async function launchChrome(opts: { profile: string; extPath?: string; headless: boolean; proxy?: string }): Promise<Browser> {
  const executablePath = findChrome();
  const args = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--window-size=1280,1024",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-infobars",
    "--disable-features=IsolateOrigins,site-per-process,DisableLoadExtensionCommandLineSwitch",
  ];
  if (opts.proxy) {
    args.push(`--proxy-server=${opts.proxy}`);
    args.push("--proxy-bypass-list=<-loopback>");
  }
  if (opts.extPath) {
    args.push(`--load-extension=${opts.extPath}`);
    args.push(`--disable-extensions-except=${opts.extPath}`);
  }
  return puppeteer.launch({
    executablePath,
    headless: opts.headless,
    userDataDir: opts.profile,
    defaultViewport: { width: 1280, height: 1024 },
    args,
    ignoreDefaultArgs: ["--enable-automation"],
  });
}

async function hardenPage(page: Page): Promise<void> {
  await page.setUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
  await page.setExtraHTTPHeaders({
    "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "accept-language": "en-US,en;q=0.9",
  });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    (window as any).chrome = (window as any).chrome || { runtime: {} };
  });
}

async function fillInput(page: Page, sel: string, value: string, timeout = 15000): Promise<void> {
  await page.waitForSelector(sel, { timeout, visible: true });
  await page.focus(sel);
  await page.evaluate((s) => {
    const el = document.querySelector(s) as any | null;
    if (el) {
      el.focus();
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, sel);
  await page.type(sel, value, { delay: 25 });
}

async function clickText(page: Page, text: string, timeout = 8000): Promise<void> {
  const variants = [`button::-p-text(${text})`, `a::-p-text(${text})`, `[role="button"]::-p-text(${text})`, `::-p-text(${text})`];
  let lastErr = "";
  for (const sel of variants) {
    try {
      const handles = await page.$$(sel);
      if (handles.length > 0) {
        await handles[0].click({ delay: 30 });
        return;
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    // fallback: cari via evaluate
    try {
      const clicked = (await page.evaluate((t) => {
        const els = Array.from(document.querySelectorAll("button, a, [role=button]"));
        const m = els.find((e) => (e.textContent || "").trim().toLowerCase().includes(t.toLowerCase()));
        if (m) {
          (m as any).click();
          return true;
        }
        return false;
      }, text)) as boolean;
      if (clicked) return;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`clickText timeout: "${text}" (${lastErr.slice(0, 120)})`);
}

async function tryClickText(page: Page, text: string, timeout = 3000): Promise<boolean> {
  try {
    await clickText(page, text, timeout);
    return true;
  } catch {
    return false;
  }
}

async function pageLooksBlocked(page: Page): Promise<string | null> {
  try {
    const info = await page.evaluate(() => {
      const title = document.title || "";
      const body = (document.body?.innerText || "").slice(0, 500);
      return { title, body, url: location.href };
    });
    const blob = `${info.title}\n${info.body}\n${info.url}`.toLowerCase();
    if (blob.includes("attention required") || blob.includes("cf-error") || blob.includes("sorry, you have been blocked")) {
      return `cloudflare block: ${info.title || info.url}`;
    }
    if (blob.includes("just a moment") || blob.includes("checking your browser")) {
      return `cloudflare challenge: ${info.title || info.url}`;
    }
    return null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── device-code exchange ke router ─────────────────────────────────────────
async function exchangeRouter(args: Args, deviceCode: string, codeVerifier: string): Promise<boolean> {
  const pollUrl = `${args.routerUrl.replace(/\/+$/, "")}/api/oauth/grok-cli/poll`;
  for (let i = 0; i < 36; i++) {
    try {
      const res = await fetch(pollUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceCode, codeVerifier }),
        signal: AbortSignal.timeout(15000),
      });
      const data = (await res.json().catch(() => ({}))) as any;
      if (data?.access_token || data?.success || data?.status === "authorized" || data?.token) {
        log({ step: 7, msg: "Router token exchange berhasil" });
        return true;
      }
      if (data?.error === "authorization_pending" || data?.error === "slow_down" || res.status === 400) {
        // masih pending, lanjut poll
      } else if (data?.error) {
        log({ step: 7, msg: `poll info: ${data.error}` });
      }
    } catch (e) {
      log({ step: 7, msg: `poll retry: ${(e as Error).message.slice(0, 100)}` });
    }
    await sleep(5000);
  }
  return false;
}

// ── main flow ────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = parseArgs();
  log({ step: 0, msg: "Memulai GAC engine (puppeteer-core)" });

  // 1) unseal turnstile ext
  log({ step: 0, msg: "Unseal ekstensi Turnstile..." });
  let extPath: string;
  try {
    extPath = await resolveTurnstileExt(args.sealUnlockUrl, args.sealToken);
    log({ step: 0, msg: "Ekstensi Turnstile siap" });
  } catch (e) {
    log({ error: `unseal gagal: ${(e as Error).message}` });
    process.exit(1);
    return;
  }

  // 2) fsmail inbox (jika email belum diberikan)
  const mail = new Fsmail(args.fsmailBaseUrl, args.fsmailApiKey, args.fsmailDomain);
  let email = args.email;
  if (!email) {
    if (!mail.ok) {
      log({ error: "Fsmail belum dikonfigurasi dan --email tidak diberikan" });
      process.exit(1);
      return;
    }
    try {
      const inbox = await mail.createInbox();
      email = inbox.address;
      log({ step: 1, msg: `Email Fsmail: ${email}` });
    } catch (e) {
      log({ error: `Fsmail createInbox gagal: ${(e as Error).message}` });
      process.exit(1);
      return;
    }
  } else {
    log({ step: 1, msg: `Pakai email: ${email}` });
    // Pastikan inbox Fsmail ada agar OTP xAI bisa diterima.
    if (mail.ok) {
      await mail.ensureInbox(email);
    } else {
      log({ step: 1, msg: "Fsmail belum dikonfigurasi — OTP mungkin gagal diterima" });
    }
  }

  const profile = mkdtempSync(join(tmpdir(), "fsr-grok-"));
  const browser = await launchChrome({ profile, extPath, headless: args.headless, proxy: args.proxy });
  try {
    const page = await browser.newPage();
    await hardenPage(page);

    // 3) buka signup / device authorization
    const startUrl = args.deviceCode
      ? `https://accounts.x.ai/authorize?redirect_uri=https://grok.com&client_id=grok-cli&response_type=code&scope=openid&code_challenge=${args.codeVerifier}&code_challenge_method=plain&state=fsrouter`
      : "https://accounts.x.ai/sign-up?redirect=grok-com";
    log({ step: 2, msg: `Buka ${startUrl}` });
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(2000);
    for (let i = 0; i < 15; i++) {
      const blocked = await pageLooksBlocked(page);
      if (!blocked) break;
      if (blocked?.startsWith("cloudflare block")) throw new Error(blocked);
      await sleep(1000);
    }
    await tryClickText(page, "Accept All Cookies", 3000);
    await tryClickText(page, "Accept all cookies", 1500);
    await sleep(500);
    log({ step: 2, msg: "Halaman load" });

    // 4) isi email (sign-up) atau lanjut ke login (authorize)
    if (!args.deviceCode) {
      const emailSel = "input[type=email], input[name=email], input[data-testid=email]";
      let emailReady = await page.$(emailSel);
      if (!emailReady) {
        for (const v of ["Sign up with email", "Sign up with Email", "Continue with email", "Email"]) {
          if (await tryClickText(page, v, 5000)) break;
        }
      }
      await page.waitForSelector(emailSel, { timeout: 12000, visible: true });
      await fillInput(page, emailSel, email);
      await page.keyboard.press("Enter");
      try {
        await page.waitForSelector("input[name=code]", { timeout: 20000, visible: true });
      } catch {
        await tryClickText(page, "Sign up", 3000);
        await page.waitForSelector("input[name=code]", { timeout: 15000, visible: true });
      }
      log({ step: 3, msg: "Email terkirim, menunggu OTP..." });

      // 5) poll OTP dari fsmail
      const t0 = Date.now();
      let code: string | null = null;
      while ((Date.now() - t0) / 1000 < 120) {
        try {
          const msgs = await mail.listMessages(email.split("@")[0]);
          for (const m of msgs) {
            const hit = extractOtp(m.subject || m.preview || "");
            if (hit) {
              code = hit;
              break;
            }
            try {
              const d = await mail.readMessage(m.id);
              const hit2 = extractOtp([d.subject, d.bodyText, d.bodyHtml].filter(Boolean).join("\n"));
              if (hit2) {
                code = hit2;
                break;
              }
            } catch {
              /* noop */
            }
          }
        } catch {
          /* noop */
        }
        if (code) break;
        await sleep(3000);
      }
      if (!code) throw new Error("OTP timeout 120s");
      log({ step: 4, msg: `OTP: ${code}` });
      await fillInput(page, "input[name=code]", code);
      await page.keyboard.press("Enter");
      await page.waitForSelector("input[name=givenName]", { timeout: 20000, visible: true });
      log({ step: 4, msg: "OTP verifikasi ok" });

      // 6) nama + password
      const local = email.split("@")[0];
      const parts = local.split(/[._-]/);
      const given = (parts[0] || "User").charAt(0).toUpperCase() + (parts[0] || "User").slice(1).toLowerCase();
      const famRaw = parts.length > 1 ? parts[1] : "AsuKabeh";
      const family = famRaw.charAt(0).toUpperCase() + famRaw.slice(1).toLowerCase();
      await fillInput(page, "input[name=givenName]", given);
      await fillInput(page, "input[name=familyName]", family);
      await fillInput(page, "input[name=password]", args.password);
      log({ step: 5, msg: "Profil diisi" });
    } else {
      // device authorization: isi login (email -> Next -> password)
      log({ step: 3, msg: "Device authorization: isi login" });
      const emailSel = "input[type='email'], input[name='email'], input[type='text']";
      await page.waitForSelector(emailSel, { timeout: 15000, visible: true });
      await fillInput(page, emailSel, email);
      const nextHandles = await page.$$("button:has-text('Next'), button:has-text('Continue'), button[type='submit']");
      if (nextHandles.length > 0) await nextHandles[0].click();
      else await page.keyboard.press("Enter");
      await sleep(2000);
      await page.waitForSelector("input[type='password'], input[name='password']", { timeout: 8000, visible: true });
      await fillInput(page, "input[type='password'], input[name='password']", args.password);
      log({ step: 3, msg: "Password diisi (multi-step login)" });
    }

    // 7) solve turnstile
    // Paksa Cloudflare me-render widget dengan memicu interaksi form dulu.
    try {
      await page.evaluate(`(() => {
        // fokus ke field terakhir biar CF anggap user aktif
        const inputs = Array.from(document.querySelectorAll('input'));
        const last = inputs[inputs.length - 1];
        if (last) { last.focus(); last.dispatchEvent(new Event('input', { bubbles: true })); last.dispatchEvent(new Event('change', { bubbles: true })); }
        // klik tombol submit agar CF lazy-render challenge
        const btns = Array.from(document.querySelectorAll('button, [role="button"], input[type=submit]'));
        const sb = btns.find((b) => /complete\\\\s*sign\\\\s*up|create\\\\s*account|sign\\\\s*up|log\\\\s*in|login/i.test(((b.textContent || b.value || '') + '').replace(/\\\\s+/g, ' ').trim()));
        if (sb) sb.click();
      })()`);
      log({ step: 6, msg: "Trigger interaksi form (picu Turnstile render)" });
    } catch { /* noop */ }
    await sleep(2500);
    let tok = "";
    for (let i = 0; i < 40; i++) {
      // Coba klik checkbox Turnstile bila ada (ekstensi akan otomatis solve)
      try {
        const clicked = (await page.evaluate(`(() => {
          const frames = Array.from(document.querySelectorAll('iframe'));
          for (const f of frames) {
            try {
              const doc = f.contentDocument || (f.contentWindow && f.contentWindow.document);
              if (!doc) continue;
              const box = doc.querySelector('input[type=checkbox], #checkbox, .ctp-checkbox, [role=checkbox]');
              if (box) { (box.click ? box.click() : (box as any).click()); return true; }
            } catch (e) { /* cross-origin, skip */ }
          }
          // fallback: checkbox di top document
          const top = document.querySelector('input[type=checkbox].ctp-checkbox, #ctp-checkbox, .cf-turnstile-checkbox');
          if (top) { (top.click ? top.click() : (top as any).click()); return true; }
          return false;
        })()`)) as boolean;
        if (clicked) await sleep(800);
      } catch { /* noop */ }
      tok = (await page.evaluate(`(() => { const el = document.querySelector('input[name=cf-turnstile-response]'); return (el && el.value) || ''; })()`)) as string;
      if (tok) break;
      await sleep(1000);
    }
    if (!tok) {
      // Diagnostik: dump kondisi halaman saat Turnstile timeout
      try {
        const diag = (await page.evaluate(`(() => {
          const iframes = Array.from(document.querySelectorAll('iframe')).map(f => ({ src: f.src, w: f.offsetWidth, h: f.offsetHeight }));
          const hasResp = !!document.querySelector('input[name=cf-turnstile-response]');
          const resp = document.querySelector('input[name=cf-turnstile-response]');
          const body = (document.body && document.body.innerText || '').slice(0, 400);
          return JSON.stringify({ iframes, hasResp, respVal: resp ? (resp.value || '').slice(0,20) : null, url: location.href, body });
        })()`)) as string;
        log({ step: 6, msg: `Turnstile diag: ${diag}` });
      } catch (e) {
        log({ step: 6, msg: `Turnstile diag err: ${(e as Error).message}` });
      }
      try { await page.screenshot({ path: "/tmp/grok_turnstile_diag.png" }); } catch {}
      throw new Error("Turnstile timeout 40s");
    }
    log({ step: 6, msg: "Turnstile terpecahkan" });

    // submit signup / login
    const submit = async (): Promise<void> => {
      const clicked = (await page.evaluate(`(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"], input[type=submit]'));
        const match = btns.find((b) => /complete\\s*sign\\s*up|create\\s*account|sign\\s*up|log\\s*in|login/i.test(((b.textContent || b.value || '') + '').replace(/\\s+/g, ' ').trim()));
        if (!match) return false;
        if (match.disabled) { match.removeAttribute('disabled'); (match as any).disabled = false; }
        match.click();
        return true;
      })()`)) as boolean;
      if (clicked) return;
      await page.evaluate(`(() => { const f = document.querySelector('form'); if (!f) return false; if (typeof f.requestSubmit === 'function') f.requestSubmit(); else f.submit(); return true; })()`);
    };
    await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => null), submit()]);
    log({ step: 6, msg: "Form disubmit" });

    // 8) klik Allow / Authorize bila ada
    for (let i = 0; i < 25; i++) {
      const url = page.url();
      if (/grok\.com/i.test(url)) break;
      for (const t of ["Allow", "Authorize", "Continue", "Accept", "Yes"]) {
        if (await tryClickText(page, t, 2000)) {
          log({ step: 7, msg: `Klik otorisasi: ${t}` });
          await sleep(2000);
          break;
        }
      }
      if (/grok\.com/i.test(page.url())) break;
      await sleep(1500);
    }

    // 9) exchange token ke router
    if (args.deviceCode) {
      const ok = await exchangeRouter(args, args.deviceCode, args.codeVerifier);
      if (!ok) log({ error: "Timeout saat menunggu router exchange token grok-cli" });
      else log({ done: true, email });
    } else {
      log({ done: true, email });
    }
  } catch (e) {
    log({ error: (e as Error).message });
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => undefined);
    cleanupSealedTemps();
  }
}

main().catch((e) => {
  log({ error: (e as Error).message });
  process.exit(1);
});
