#!/usr/bin/env python3
"""Grok CLI (X.AI) account auto-signup via Camoufox (anti-fingerprint) + Fsmail OTP.

Flow (mirrors the dashboard "Add" button for provider grok-cli):
  1. Ask the router for a device_code + verification URL (router owns PKCE verifier).
  2. Open the verification URL in the browser. If X.AI redirects to sign-up
     (new account), complete the email signup + OTP + password IN THE SAME TAB
     so the session stays continuous, then authorize the device (Continue).
  3. Hand the device_code back to the router (/api/oauth/grok-cli/poll) which
     exchanges it for a token and persists the connection.

Outputs JSON lines to stdout:
  {"step": "..."}            — progress update
  {"status": "success", ...} — final result (connection_id)
  {"status": "error", ...}   — failure
"""

import sys
import json
import argparse
import time
import random
import string
import re
import urllib.request
import urllib.parse
import urllib.error
import os
import tempfile
import base64
import hashlib
from pathlib import Path
from playwright.sync_api import sync_playwright

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except ImportError:
    AESGCM = None

# ── Stdout JSON helpers ────────────────────────────────────────────────────────
def emit(obj):
    print(json.dumps(obj), flush=True)

def log_step(msg):
    emit({"step": msg})

def die(msg):
    emit({"status": "error", "error": msg})
    sys.exit(1)

# ── Fsmail helpers ─────────────────────────────────────────────────────────────
def fsmail_request(base_url, api_key, path, method="GET", data=None, host_header=None):
    url = base_url.rstrip("/") + "/api" + path
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("X-API-Key", api_key)
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "Mozilla/5.0")
    req.add_header("Accept", "application/json, */*")
    if host_header:
        req.add_header("Host", host_header)
    elif "localhost" in base_url or "127.0.0.1" in base_url:
        req.add_header("Host", "fsmail.klipers.site")
    if data:
        req.data = json.dumps(data).encode()
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())

def create_fsmail_inbox(base_url, api_key, email):
    try:
        alias, domain = email.split("@", 1)
        fsmail_request(base_url, api_key, "/inboxes", method="POST",
                       data={"alias": alias, "domain": domain})
    except Exception:
        pass

def _extract_xai_code(subject, body):
    """X.AI sends 6-char alphanumeric codes like 'O8I-NV6' (NOT all digits).
    Email HTML also contains CSS hex colors (#333333) that fool a naive \\d{6}
    regex, so we prioritize the 'XXX-XXX' pattern and require at least one letter."""
    candidates = []
    for m in re.finditer(r'(?i)confirmation code[:\s]+([A-Z0-9]{3})[-\s]?([A-Z0-9]{3})', subject):
        candidates.append((m.group(1) + m.group(2), 0))
    for m in re.finditer(r'(?i)\b([A-Z0-9]{3})[-\s]([A-Z0-9]{3})\b', body or ""):
        candidates.append((m.group(1) + m.group(2), 1))
    for m in re.finditer(r'\b([A-Z0-9]{6})\b', body or ""):
        tok = m.group(1)
        if re.search(r'[A-Z]', tok):
            candidates.append((tok, 2))
    for code, _prio in sorted(candidates, key=lambda x: x[1]):
        if len(code) == 6 and re.search(r'[A-Z0-9]', code):
            return code.upper()
    return None

def wait_for_xai_otp(base_url, api_key, email, timeout=120):
    log_step(f"Menunggu OTP email X.AI ({email})...")
    alias = email.split("@")[0]
    deadline = time.time() + timeout
    seen_ids = set()
    while time.time() < deadline:
        try:
            data = fsmail_request(base_url, api_key, f"/inboxes/{urllib.parse.quote(alias)}/messages")
            messages = data.get("messages", [])
            for msg in messages:
                msg_id = msg.get("id", "")
                subject = msg.get("subject", "")
                if msg_id in seen_ids:
                    continue
                seen_ids.add(msg_id)
                subj_lower = subject.lower()
                if "x.ai" in subj_lower or "verification" in subj_lower or "code" in subj_lower or "security" in subj_lower:
                    try:
                        full = fsmail_request(base_url, api_key, f"/messages/{urllib.parse.quote(msg_id)}")
                        msg_body = full.get("message", full)
                        body = msg_body.get("body", msg_body.get("html", msg_body.get("text", "")))
                        if not isinstance(body, str):
                            body = str(body)
                    except Exception:
                        body = msg.get("snippet", "")
                    code = _extract_xai_code(subject, body)
                    if code:
                        log_step(f"OTP Ditemukan: {code}")
                        return code
        except Exception:
            pass
        time.sleep(4)
    return None

# ── Cookie banner helpers ──────────────────────────────────────────────────────
def dismiss_cookie_banner(page):
    try:
        # Coba klik tombol ID OneTrust
        page.evaluate("""() => {
            const b = document.getElementById('onetrust-accept-btn-handler') || document.querySelector('button[id*="accept"]');
            if (b) {
                b.click();
                return true;
            }
            // Fallback cari text accept/allow
            const btns = Array.from(document.querySelectorAll('button'));
            const acceptBtn = btns.find(btn => {
                const txt = btn.textContent.toLowerCase();
                return txt.includes('accept all') || txt.includes('accept cookies') || txt.includes('allow all');
            });
            if (acceptBtn) {
                acceptBtn.click();
                return true;
            }
            return false;
        }""")
    except Exception:
        pass

# ── Turnstile bypass ───────────────────────────────────────────────────────────
def is_on_turnstile_page(page) -> bool:
    try:
        title = page.title() or ""
        if "just a moment" in title.lower() or "security verification" in title.lower() or "attention required" in title.lower():
            return True
    except Exception:
        pass
    try:
        token = page.evaluate("() => { const el = document.getElementsByName('cf-turnstile-response')[0] || document.getElementById('cf-turnstile-response'); return el ? el.value : null; }")
        if token is not None:
            return len(token.strip()) == 0
    except Exception:
        pass
    return False

def try_click_turnstile_checkbox(page) -> bool:
    target_frames = []
    try:
        # Masukkan semua frames ke kandidat
        for f in page.frames:
            target_frames.append(f)
    except Exception:
        pass
    
    # Fallback: Cari menggunakan selector iframe dan ambil content_frame-nya
    try:
        iframes = page.locator("iframe").all()
        for iframe_el in iframes:
            try:
                cf = iframe_el.content_frame()
                if cf and cf not in target_frames:
                    target_frames.append(cf)
            except Exception:
                pass
    except Exception:
        pass

    for target_frame in target_frames:
        if not target_frame:
            continue
        try:
            # Cari checkbox di dalam target_frame
            for cb_sel in ["input[type='checkbox']", "[role='checkbox']", "div.ctp-checkbox-label", "span.mark"]:
                try:
                    box = target_frame.locator(cb_sel).first
                    if box.count() > 0 and box.is_visible(timeout=500):
                        box_rect = box.bounding_box()
                        
                        # Cari frame element pembungkus untuk koordinat klik absolut
                        frame_element = None
                        try:
                            # Cari iframe yang mengarah ke target_frame ini
                            for ifr in page.locator("iframe").all():
                                if ifr.content_frame() == target_frame:
                                    frame_element = ifr
                                    break
                        except Exception:
                            pass
                        
                        frame_rect = frame_element.bounding_box() if frame_element else None
                        
                        if box_rect and frame_rect:
                            click_x = frame_rect['x'] + box_rect['x'] + (box_rect['width'] / 2)
                            click_y = frame_rect['y'] + box_rect['y'] + (box_rect['height'] / 2)
                            
                            log_step(f"Mensimulasikan gerakan & klik mouse fisik ke Turnstile checkbox di ({click_x}, {click_y})")
                            page.mouse.move(click_x, click_y, steps=5)
                            time.sleep(0.1)
                            page.mouse.down()
                            time.sleep(0.05)
                            page.mouse.up()
                            return True
                        else:
                            box.click(timeout=1000, force=True)
                            return True
                except Exception:
                    continue
        except Exception:
            continue
    return False

def wait_for_cf_clearance(page, timeout=45.0):
    if not is_on_turnstile_page(page):
        return True
    log_step("Cloudflare Turnstile terdeteksi, menunggu resolve...")
    deadline = time.time() + timeout
    click_attempts = 0
    next_click_at = time.time() + 4.0
    while time.time() < deadline:
        time.sleep(2.0)
        if not is_on_turnstile_page(page):
            log_step("Turnstile selesai!")
            try:
                page.wait_for_load_state("networkidle", timeout=5000)
            except Exception:
                pass
            return True
        now = time.time()
        if click_attempts < 5 and now >= next_click_at:
            click_attempts += 1
            log_step(f"Klik Turnstile checkbox (attempt {click_attempts}/5)...")
            try_click_turnstile_checkbox(page)
            next_click_at = now + 8.0
            time.sleep(2.0)
    return False

# ── Main ───────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--email", required=True)
    parser.add_argument("--password", required=True)
    parser.add_argument("--fsmail-base-url", default="")
    parser.add_argument("--fsmail-api-key", default="")
    parser.add_argument("--fsmail-domain", default="")
    parser.add_argument("--profiles-dir", default="profiles/grok")
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--stagger-delay", type=int, default=0)
    parser.add_argument("--proxy-server")
    parser.add_argument("--proxy-user")
    parser.add_argument("--proxy-pass")
    parser.add_argument("--router-url", default="")
    parser.add_argument("--router-password", default="")
    parser.add_argument("--seal-unlock-url", default="")
    parser.add_argument("--seal-token", default="")
    args = parser.parse_args()

    if args.fsmail_base_url and args.fsmail_api_key:
        create_fsmail_inbox(args.fsmail_base_url, args.fsmail_api_key, args.email)

    if args.stagger_delay > 0:
        log_step(f"Stagger delay {args.stagger_delay}s...")
        time.sleep(args.stagger_delay)

    # Setup Playwright Chrome with Extension
    ext_path = "/root/AMRouter/backend/src/automation/turnstilePatch"
    
    # Check if we should unseal turnstile script using remote key
    sealed_file = os.path.join(ext_path, "script.sealed")
    if os.path.exists(sealed_file) and AESGCM is not None:
        if args.seal_unlock_url:
            log_step("Unsealing Turnstile bypass patch...")
            try:
                with open(sealed_file, "r", encoding="utf-8") as sf:
                    blob = json.load(sf)
                kid = blob.get("kid", "default")
                # Fetch remote key
                query = urllib.parse.urlencode({"kid": kid, "app": "wanglin-s-grok-signup"})
                unlock_url = f"{args.seal_unlock_url.rstrip('/')}?{query}"
                
                req = urllib.request.Request(unlock_url)
                req.add_header("Accept", "application/json")
                req.add_header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
                if args.seal_token:
                    req.add_header("Authorization", f"Bearer {args.seal_token}")
                
                with urllib.request.urlopen(req, timeout=10) as resp:
                    resp_data = json.loads(resp.read().decode())
                    key_b64 = resp_data["key"]
                
                # Decrypt AES-256-GCM
                key = base64.b64decode(key_b64)
                iv = base64.b64decode(blob["iv"])
                tag = base64.b64decode(blob["tag"])
                ct = base64.b64decode(blob["ct"])
                
                aesgcm = AESGCM(key)
                # python cryptography expects combined ciphertext + tag
                decrypted = aesgcm.decrypt(iv, ct + tag, None)
                
                # Write to script.js
                with open(os.path.join(ext_path, "script.js"), "w", encoding="utf-8") as jf:
                    jf.write(decrypted.decode("utf-8"))
                log_step("Bypass patch unsealed successfully!")
            except Exception as e:
                log_step(f"Warning: Gagal unseal bypass patch ({e}), fallback ke script.js bawaan.")
        else:
            log_step("Bypass patch unseal skipped: SEAL_UNLOCK_URL not configured")

    profile = str(Path(tempfile.gettempdir()) / f"grok-pw-{int(time.time())}")
    
    # We must use xvfb-run if headless=False on linux, or we just rely on the router backend setup
    # Because we're migrating away from camoufox, we launch persistent chromium.
    launch_args = [
        '--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled',
        f'--load-extension={ext_path}', f'--disable-extensions-except={ext_path}'
    ]
    if args.proxy_server:
        # Not handling proxy dynamically right now, just passing standard proxy if set
        pass

    with sync_playwright() as p:
        try:
            # force headless=False so extension works. we assume it runs via xvfb in PM2.
            ctx = p.chromium.launch_persistent_context(
                user_data_dir=profile, 
                headless=False, 
                channel='chrome',
                args=launch_args,
                viewport={'width':1280,'height':1024},
                ignore_default_args=['--enable-automation'],
            )
        except Exception as e:
            die(f"Gagal me-launch Playwright Chromium: {e}")
            return

        page = ctx.new_page()
        
        # Override headers
        page.set_extra_http_headers({
            'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not-A.Brand";v="99"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Linux"',
            'accept-language': 'en-US,en;q=0.9',
        })

        def fill_react(selector, value):
            try:
                el = page.locator(selector).first
                el.evaluate(
                    """(el, val) => {
                        el.focus();
                        const nativeSetter = Object.getOwnPropertyDescriptor(
                            window.HTMLInputElement.prototype, 'value'
                        ).set;
                        nativeSetter.call(el, val);
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        el.dispatchEvent(new Event('blur', { bubbles: true }));
                    }""",
                    value,
                )
                time.sleep(0.3)
            except Exception:
                pass

        def click_confirm_email():
            try:
                page.evaluate("""() => {
                    const findAndClick = () => {
                        const elements = Array.from(document.querySelectorAll('button, div, span'));
                        const btn = elements.find(el => {
                            const txt = el.textContent.trim().toLowerCase();
                            return (txt === 'confirm email' || txt === 'verify') && el.offsetHeight > 0;
                        });
                        if (btn) {
                            btn.focus();
                            btn.click();
                            const clickEvent = new MouseEvent('click', { view: window, bubbles: true, cancelable: true });
                            btn.dispatchEvent(clickEvent);
                            return true;
                        }
                        return false;
                    };
                    findAndClick();
                }""")
            except Exception:
                pass
            time.sleep(1)
            try:
                cb = page.locator("button:has-text('Confirm email'), button:has-text('Verify')").last
                if cb.count() > 0 and cb.is_visible(timeout=2000):
                    cb.click(force=True, timeout=3000)
            except Exception:
                pass

        # ── Step 1: Sign up at x.ai directly ────────────────────────────────────
        log_step("Membuka halaman pendaftaran X.AI...")
        try:
            page.goto("https://accounts.x.ai/sign-up", wait_until="domcontentloaded", timeout=45000)
            wait_for_cf_clearance(page, timeout=30)
        except Exception as e:
            log_step(f"Goto sign-up error: {e}")
 
        time.sleep(2)
        dismiss_cookie_banner(page)

        log_step("Mengisi form pendaftaran email...")
        try:
            cb = page.locator("button#onetrust-accept-btn-handler, button#onetrust-reject-all-handler").first
            if cb.count() > 0 and cb.is_visible(timeout=3000):
                cb.click(timeout=1000); time.sleep(1)
        except Exception:
            pass
        dismiss_cookie_banner(page)
        
        try:
            seb = page.locator("button:has-text('Sign up with email')").last
            if seb.count() > 0 and seb.is_visible(timeout=5000):
                seb.click(force=True, timeout=5000); time.sleep(2)
        except Exception as e:
            log_step(f"Warning: klik sign up with email: {e}")
        
        try:
            page.wait_for_selector("input[type='email']", timeout=10000)
            fill_react("input[type='email']", args.email)
            try_click_turnstile_checkbox(page)
            time.sleep(1)
            sb = page.locator("button[type='submit'], button:has-text('Sign up')").first
            if sb.count() > 0 and sb.is_visible():
                sb.click(timeout=5000)
            else:
                page.keyboard.press("Enter")
            time.sleep(3)
        except Exception as e:
            log_step(f"Signup form error: {e}")

        # ── Step 2: OTP verification ───────────────────────────────────────────
        log_step("Menunggu form verifikasi email / OTP...")
        try:
            page.wait_for_selector("input[name='code'], input[type='text']", timeout=15000)
        except Exception:
            pass
        otp_val = wait_for_xai_otp(args.fsmail_base_url, args.fsmail_api_key, args.email, timeout=90)
        if not otp_val:
            die("OTP verifikasi x.ai tidak kunjung masuk ke FSMail.")
        log_step(f"Mengisi OTP: {otp_val}")
        try:
            fill_react("input[name='code']", otp_val)
        except Exception:
            pass
        code_el = page.locator("input[name='code'], input[type='text']").first
        try:
            code_el.click(force=True); code_el.fill(otp_val)
        except Exception:
            pass
        time.sleep(3)
        dismiss_cookie_banner(page)
        click_confirm_email()

        # ── Step 3: Complete profile / password ───────────────────────────────
        log_step("Menunggu form pengisian password / profile baru...")
        try:
            page.wait_for_selector("input[type='password'], input[name='password']", timeout=15000)
        except Exception as e:
            try:
                page.screenshot(path="/tmp/grok_diag_password.png")
            except Exception:
                pass
            log_step(f"Warning: Gagal memuat form password: {e} - Akan mencoba melanjutkan fallback login jika diperlukan.")

        fname_inputs = page.locator("input[name*='first'], input[name*='given']").all()
        if fname_inputs:
            fname = ''.join(random.choices(string.ascii_uppercase, k=1)) + ''.join(random.choices(string.ascii_lowercase, k=5))
            fill_react("input[name*='first'], input[name*='given']", fname)
        lname_inputs = page.locator("input[name*='last'], input[name*='family']").all()
        if lname_inputs:
            lname = ''.join(random.choices(string.ascii_uppercase, k=1)) + ''.join(random.choices(string.ascii_lowercase, k=6))
            fill_react("input[name*='last'], input[name*='family']", lname)
        fill_react("input[type='password'], input[name='password']", args.password)
        pw_submit = page.locator("button[type='submit'], button:has-text('Complete sign up'), button:has-text('Continue')").first
        if pw_submit.count() > 0 and pw_submit.is_visible():
            pw_submit.click(timeout=5000)
        else:
            page.keyboard.press("Enter")
        
        # VERY IMPORTANT: Tunggu signup benar-benar selesai sebelum goto URL baru!
        log_step("Menunggu proses signup selesai dan masuk ke dashboard X.AI...")
        last_body = ""
        redirect_success = False
        for i in range(25):
            try: 
                url = page.url
                # Tunggu redirect full ke grok.com (berarti login cookies sudah 100% tersimpan)
                if "grok.com" in url:
                    log_step(f"Redirect success: {url}")
                    redirect_success = True
                    break
            except: 
                pass
            time.sleep(2)
            
        time.sleep(4)
        log_step("Pendaftaran akun X.AI selesai.")
        
# Ambil dan pastikan cookies SSO aman
        sso_cookies = page.context.cookies()
        
        # Duplikasikan cookies SSO ke domain .x.ai, accounts.x.ai, dan auth.x.ai agar session otorisasi tidak mental/login ulang
        normalized_cookies = []
        sso_names = {"sso", "sso-rw", "cf_clearance", "sso_jwt", "__cf_bm"}
        for c in sso_cookies:
            c_name = c.get("name") or ""
            c_val = c.get("value")
            if not c_name or c_val is None:
                continue
            
            # Buat base cookie item
            item: dict = {
                "name": c_name,
                "value": c_val,
                "domain": c.get("domain", ".x.ai"),
                "path": c.get("path", "/"),
            }
            if "expires" in c:
                item["expires"] = c["expires"]
            if "secure" in c:
                item["secure"] = c["secure"]
            if "httpOnly" in c:
                item["httpOnly"] = c["httpOnly"]
            if "sameSite" in c:
                ss = c["sameSite"]
                if ss not in ("Strict", "Lax", "None"):
                    ss = "Lax"
                item["sameSite"] = ss
            normalized_cookies.append(item)

            # Clone SEMUA cookies ke subdomain krusial agar session tidak hilang
            for dom in [".x.ai", "accounts.x.ai", ".accounts.x.ai", "auth.x.ai", ".auth.x.ai"]:
                if dom != c.get("domain"):
                    clone = dict(item)
                    clone["domain"] = dom
                    normalized_cookies.append(clone)

        log_step(f"Semua cookies diduplikasi: {len(normalized_cookies)} items generated.")
        
        # ── Step 4: Request device code ─────────────────────────────────────────
        router_base = args.router_url.rstrip('/') if args.router_url else "http://127.0.0.1:20128"
        log_step("Mengambil device_code untuk otorisasi Grok CLI...")
        
        user_code = None
        device_code = None
        device_code_verifier = None
        verification_uri = None
        
        # 1. Coba minta device code via target router dulu
        try:
            req = urllib.request.Request(f"{router_base}/api/oauth/grok-cli/device-code", method="GET")
            req.add_header("x-9r-cli-token", "0202c5f8e7eb28ca")  # bypass auth
            with urllib.request.urlopen(req, timeout=15) as r:
                dc_res = json.loads(r.read())
            user_code = dc_res.get("user_code")
            device_code = dc_res.get("device_code")
            device_code_verifier = dc_res.get("codeVerifier")
            verification_uri = dc_res.get("verification_uri_complete") or dc_res.get("verification_uri")
        except Exception as e:
            log_step(f"Router request device code gagal ({e}), fallback request direct ke X.AI...")

        # 2. Fallback: Request device code langsung ke X.AI jika router di-rate-limit
        if not user_code or not device_code:
            try:
                device_code_verifier = base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("=")
                code_challenge = base64.urlsafe_b64encode(hashlib.sha256(device_code_verifier.encode()).digest()).decode().rstrip("=")
                
                body_params = {
                    "client_id": "b1a00492-073a-47ea-816f-4c329264a828",
                    "scope": "openid profile email offline_access grok-cli:access api:access",
                    "code_challenge": code_challenge,
                    "code_challenge_method": "S256",
                    "referrer": "grok-build"
                }
                xreq = urllib.request.Request("https://auth.x.ai/oauth2/device/code", data=urllib.parse.urlencode(body_params).encode(), method="POST")
                xreq.add_header("Content-Type", "application/x-www-form-urlencoded")
                xreq.add_header("Accept", "application/json")
                xreq.add_header("User-Agent", "grok-pager/0.2.93 grok-shell/0.2.93 (linux; x86_64)")
                with urllib.request.urlopen(xreq, timeout=15) as xr:
                    xdc_res = json.loads(xr.read())
                user_code = xdc_res.get("user_code")
                device_code = xdc_res.get("device_code")
                verification_uri = xdc_res.get("verification_uri_complete") or xdc_res.get("verification_uri")
            except Exception as xe:
                die(f"Gagal mendapatkan device-code dari X.AI direct: {xe}")

        if not user_code or not device_code:
            die("Gagal mendapatkan user_code atau device_code untuk otorisasi.")

        log_step(f"Device Code Grok CLI didapatkan: {user_code}")

        # ── Step 5: Authorize device (Continue + Allow) ────────────────────
        auth_url = verification_uri or f"https://accounts.x.ai/oauth2/device?user_code={user_code}"
        log_step(f"Membuka halaman otorisasi Grok CLI: {auth_url}")
        
        try:
            # Re-inject cookies yang sudah dinormalisasi dan diduplikasi ke subdomain x.ai
            if normalized_cookies:
                try:
                    page.context.clear_cookies()
                    page.context.add_cookies(normalized_cookies)
                    log_step("Normalized SSO cookies successfully injected into context.")
                except Exception as ce:
                    log_step(f"Error injecting cookies: {ce}")

            page.goto(auth_url, wait_until="domcontentloaded", timeout=45000)
            wait_for_cf_clearance(page, timeout=30)
        except Exception as e:
            log_step(f"Goto device url error: {e}")

        time.sleep(3)
        
        # 1. Halaman Step 1: verify user code -> klik Continue
        try:
            btn_continue = page.get_by_role('button', name='Continue', exact=False).first
            if btn_continue.count() > 0 and btn_continue.is_visible(timeout=5000):
                log_step("Klik tombol 'Continue' di halaman verify code...")
                btn_continue.click(timeout=5000)
                time.sleep(3)
        except Exception:
            pass

        # 2. Halaman Step 2: Consent -> klik Allow / Allow All
        try:
            btn_allow = page.get_by_role('button', name='Allow', exact=False).first
            if btn_allow.count() > 0 and btn_allow.is_visible(timeout=6000):
                log_step("Klik tombol 'Allow' di halaman consent...")
                btn_allow.click(timeout=5000)
                time.sleep(2)
            else:
                btn_all = page.get_by_role('button', name='Allow All', exact=False).first
                if btn_all.count() > 0 and btn_all.is_visible(timeout=3000):
                    log_step("Klik tombol 'Allow All'...")
                    btn_all.click(timeout=5000)
                    time.sleep(2)
        except Exception:
            pass

        # Fallback tombol lain jika teks berbeda
        for btn_txt in ["Authorize", "Accept", "Confirm", "Yes"]:
            try:
                btn = page.locator(f"button:has-text('{btn_txt}')").first
                if btn.count() > 0 and btn.is_visible(timeout=2000):
                    log_step(f"Klik fallback tombol: {btn_txt}")
                    btn.click(force=True, timeout=4000)
                    time.sleep(2)
            except Exception:
                pass

        # Jika masih minta login karena cookies reset (jarang terjadi di tab yang sama)
        if "sign-in" in page.url.lower() or "login" in page.url.lower():
            log_step("Halaman otorisasi meminta login kembali...")
            try:
                # Accept cookie jika ada
                dismiss_cookie_banner(page)
                time.sleep(1)
                
                # Klik login dengan email jika ada layar picker metode login awal
                leb = page.locator("button:has-text('Login with email'), button:has-text('Continue with email')").first
                if leb.count() > 0 and leb.is_visible(timeout=3000):
                    log_step("Klik tombol 'Login with email' picker...")
                    leb.click(force=True, timeout=5000)
                    time.sleep(2)
                
                # Tunggu form login termuat dengan benar
                page.wait_for_selector("input[type='email'], input[name='email']", timeout=15000)
                
                em = page.locator("input[type='email'], input[name='email'], input[type='text']").first
                if em.count() > 0:
                    em.fill(args.email); time.sleep(0.5)
                pw = page.locator("input[type='password'], input[name='password']").first
                if pw.count() > 0:
                    pw.fill(args.password); time.sleep(0.5)
                
                # Selesaikan Turnstile di login page
                log_step("Mencoba menyelesaikan Turnstile di login fallback...")
                
                # Debug deteksi Turnstile
                try:
                    iframes_info = page.evaluate("""() => {
                        return Array.from(document.querySelectorAll('iframe')).map(f => ({
                            src: f.src,
                            visible: f.offsetHeight > 0,
                            id: f.id
                        }));
                    }""")
                    log_step(f"DEBUG IFRAMES: {iframes_info}")
                except Exception as de:
                    log_step(f"DEBUG IFRAMES error: {de}")

                # Tunggu iframe Turnstile muncul
                try:
                    page.wait_for_selector("iframe[src*='challenges.cloudflare.com'], iframe[src*='turnstile']", timeout=12000)
                except Exception:
                    pass

                turnstile_clicked = False
                for _ in range(8):
                    if try_click_turnstile_checkbox(page):
                        turnstile_clicked = True
                        log_step("Turnstile checkbox berhasil diklik.")
                        break
                    time.sleep(1.5)

                # Tunggu token turnstile terisi
                log_step("Menunggu Turnstile terverifikasi...")
                token_resolved = False
                for _ in range(12):
                    try:
                        token = page.evaluate("() => { const el = document.getElementsByName('cf-turnstile-response')[0] || document.getElementById('cf-turnstile-response'); return el ? el.value : ''; }")
                        if token and len(token.strip()) > 0:
                            token_resolved = True
                            log_step("Turnstile sukses terverifikasi!")
                            break
                    except Exception:
                        pass
                    time.sleep(1)

                # Klik tombol login yang benar (Login / Log in / Sign in)
                sub = page.locator("button:has-text('Login'), button:has-text('Log in'), button:has-text('Sign in'), button[type='submit']").first
                if sub.count() > 0 and sub.is_visible(timeout=3000):
                    log_step("Submit login fallback...")
                    sub.click(force=True, timeout=5000)
                else:
                    page.keyboard.press("Enter")
                
                # Tunggu load state setelah submit
                try:
                    page.wait_for_load_state("networkidle", timeout=6000)
                except Exception:
                    pass
                time.sleep(3)
                
                page.screenshot(path="/tmp/grok_after_reauth.png")
                log_step(f"DIAG after re-auth url={page.url}")

                # JIKA meminta OTP login kedua (passwordless fallback)
                otp_input = page.locator("input[name='code'], input[placeholder*='code']").first
                if otp_input.count() > 0 or "email=true" in page.url:
                    log_step("Login meminta verifikasi OTP tambahan...")
                    try:
                        page.wait_for_selector("input[name='code'], input[placeholder*='code']", timeout=15000)
                        otp_input = page.locator("input[name='code'], input[placeholder*='code']").first
                    except Exception:
                        pass
                    
                    login_otp = wait_for_xai_otp(args.fsmail_base_url, args.fsmail_api_key, args.email, timeout=120)
                    if login_otp:
                        log_step(f"Mengisi OTP login fallback: {login_otp}")
                        try:
                            otp_input.click(force=True)
                            otp_input.fill(login_otp)
                        except Exception:
                            pass
                        time.sleep(0.3)
                        page.keyboard.press("Enter")
                        try:
                            page.wait_for_load_state("networkidle", timeout=10000)
                        except Exception:
                            pass
                        time.sleep(4)
                        
                        # Ambil screenshot diagnostic setelah submit OTP fallback
                        try:
                            page.screenshot(path="/tmp/grok_after_allow.png")
                            log_step(f"DIAG after OTP fallback url={page.url}")
                        except Exception:
                            pass

                # Coba klik otorisasi lagi
                for btn_txt in ["Continue", "Allow", "Authorize", "Accept"]:
                    try:
                        btn = page.locator(f"button:has-text('{btn_txt}')").first
                        if btn.count() > 0 and btn.is_visible(timeout=3000):
                            log_step(f"Klik tombol otorisasi setelah login: {btn_txt}")
                            btn.click(force=True, timeout=5000)
                            time.sleep(2)
                            break
                    except Exception:
                        pass
            except Exception as le:
                log_step(f"Login fallback device error: {le}")

        time.sleep(4)
        try:
            page.screenshot(path="/tmp/grok_final_state.png")
        except Exception:
            pass
        try:
            post_url = page.url
            page.screenshot(path="/tmp/grok_after_allow.png")
            log_step(f"DIAG after-allow url={post_url}")
        except Exception as de:
            log_step(f"DIAG after-allow error: {de}")

        # ── Step 6: Hand off to target router for token exchange + persistence ─────────
        log_step("Menyerahkan device_code ke target router untuk exchange token...")
        token_found = False
        
        # Kita harus menggunakan router_base yang sudah diset di Step 4
        # atau fallback ke http://127.0.0.1:20128 jika tidak ada target
        poll_base_url = router_base if 'router_base' in locals() and router_base else "http://127.0.0.1:20128"
        
        for _ in range(36):
            try:
                pr = urllib.request.Request(
                    f"{poll_base_url}/api/oauth/grok-cli/poll",
                    data=json.dumps({
                        "deviceCode": device_code,
                        "codeVerifier": device_code_verifier,
                    }).encode(),
                    method="POST",
                    headers={
                        "Content-Type": "application/json",
                        "x-9r-cli-token": "0202c5f8e7eb28ca",
                    },
                )
                with urllib.request.urlopen(pr, timeout=15) as r:
                    res = json.loads(r.read())
                if res.get("success"):
                    conn = res.get("connection", {})
                    emit({
                        "status": "success",
                        "email": args.email,
                        "connection_id": conn.get("id"),
                        "provider": conn.get("provider", "grok-cli"),
                    })
                    token_found = True
                    break
            except Exception:
                pass
            time.sleep(5)

        if not token_found:
            die("Timeout saat menunggu router exchange token grok-cli.")

if __name__ == "__main__":
    main()
