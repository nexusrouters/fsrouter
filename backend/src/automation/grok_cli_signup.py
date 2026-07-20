#!/usr/bin/env python3
"""Grok CLI (X.AI) account auto-signup via Camoufox (anti-fingerprint) + Fsmail OTP.

Outputs JSON lines to stdout:
  {"step": "..."} — progress update
  {"status": "success", "email": "..."} — final result
  {"status": "error", "error": "..."} — failure
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
from pathlib import Path

# ── Stdout JSON helpers ────────────────────────────────────────────────────────
def emit(obj):
    print(json.dumps(obj), flush=True)

def log_step(msg):
    emit({"step": msg})

def success(email):
    emit({"status": "success", "email": email})

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
                if "x.ai" in subj_lower or "verification" in subj_lower or "code" in subj_lower:
                    try:
                        full = fsmail_request(base_url, api_key, f"/messages/{urllib.parse.quote(msg_id)}")
                        msg_body = full.get("message", full)
                        body = msg_body.get("body", msg_body.get("html", msg_body.get("text", "")))
                    except Exception:
                        body = msg.get("snippet", "")
                    
                    # Cari 6 digit code
                    codes = re.findall(r'\b(\d{6})\b', body)
                    if codes:
                        log_step(f"OTP Ditemukan: {codes[0]}")
                        return codes[0]
        except Exception as e:
            pass
        time.sleep(4)
    return None

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
    target_frame = None
    try:
        for f in page.frames:
            url = f.url or ""
            if "challenges.cloudflare.com" in url or "turnstile" in url:
                target_frame = f
                break
    except Exception:
        pass

    if target_frame:
        try:
            frame_element = page.locator("iframe[src*='challenges.cloudflare.com'], iframe[src*='turnstile']").first
            if frame_element.count() > 0 and not frame_element.is_visible(timeout=500):
                return False
        except Exception:
            pass
        for cb_sel in ["input[type='checkbox']", "[role='checkbox']", "div.ctp-checkbox-label"]:
            try:
                box = target_frame.locator(cb_sel).first
                if box.count() > 0 and box.is_visible(timeout=500):
                    box.click(timeout=1000, force=True)
                    return True
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
    parser.add_argument("--proxy-server")
    parser.add_argument("--proxy-user")
    parser.add_argument("--proxy-pass")
    args = parser.parse_args()

    # Pre-create inbox
    if args.fsmail_base_url and args.fsmail_api_key:
        create_fsmail_inbox(args.fsmail_base_url, args.fsmail_api_key, args.email)

    import camoufox
    
    proxy_dict = None
    if args.proxy_server:
        proxy_dict = {"server": args.proxy_server}
        if args.proxy_user:
            proxy_dict["username"] = args.proxy_user
        if args.proxy_pass:
            proxy_dict["password"] = args.proxy_pass

    log_step(f"Meluncurkan stealth browser (headless={args.headless})...")
    with camoufox.Camoufox(
        headless=args.headless,
        proxy=proxy_dict,
        geoip=True,
        enable_cache=True,
    ) as browser:
        page = browser.new_page()
        
        # Step 1: Request Device Code for Grok CLI locally
        log_step("Request Device Code Grok CLI...")
        user_code = None
        device_code = None
        try:
            req = urllib.request.Request("http://127.0.0.1:20128/api/oauth/grok-cli/device-code", method="GET")
            req.add_header("x-9r-cli-token", "0202c5f8e7eb28ca") # Bypassing auth locally
            with urllib.request.urlopen(req, timeout=10) as r:
                dc_res = json.loads(r.read())
            user_code = dc_res.get("user_code")
            device_code = dc_res.get("device_code")
            if not user_code:
                die("Gagal mendapatkan user_code dari router")
            log_step(f"Device Code Grok CLI didapatkan: {user_code}")
        except Exception as e:
            die(f"Gagal request device code: {e}")

        # Step 2: Sign-up X.AI
        log_step("Membuka x.ai signup page...")
        try:
            page.goto("https://accounts.x.ai/sign-up", wait_until="domcontentloaded", timeout=45000)
            wait_for_cf_clearance(page, timeout=30)
            
            content = page.content().lower()
            if "blocked" in content or "attention required" in page.title().lower():
                page.screenshot(path="/tmp/grok_blocked.png")
                die("Akses diblokir oleh WAF Cloudflare X.AI (Attention Required). Gunakan Proxy Residential atau daftar manual.")
            
            # Form email & password
            log_step("Mengisi form pendaftaran X.AI...")
            page.wait_for_selector("input[type='email'], input[name='email']", timeout=15000)
            page.fill("input[type='email'], input[name='email']", args.email)
            page.fill("input[type='password'], input[name='password']", args.password)
            
            # Turnstile checkbox in form (if any)
            try_click_turnstile_checkbox(page)
            time.sleep(2)
            
            submit_btn = page.locator("button[type='submit'], button:has-text('Sign up'), button:has-text('Create')").first
            if submit_btn.is_visible():
                submit_btn.click()
            else:
                page.keyboard.press("Enter")
            
            # Step 3: Verifikasi OTP
            log_step("Menunggu form verifikasi email / OTP...")
            otp_found = False
            for _ in range(15):
                if page.locator("input[name*='code'], input[type='text'], input").count() > 2:
                    otp_found = True
                    break
                time.sleep(1)
            
            if not otp_found:
                die("Form OTP tidak muncul setelah pendaftaran. Mungkin WAF memblokir form submission.")

            otp_val = wait_for_xai_otp(args.fsmail_base_url, args.fsmail_api_key, args.email, timeout=90)
            if not otp_val:
                die("OTP verifikasi x.ai tidak kunjung masuk ke FSMail.")
            
            # Fill OTP inputs
            log_step(f"Mengisi OTP: {otp_val}")
            otp_inputs = page.locator("input[type='text']").all()
            for idx, ch in enumerate(otp_val):
                if idx < len(otp_inputs):
                    otp_inputs[idx].fill(ch)
            time.sleep(3)
            
            # Step 4: Menavigasi ke OAuth Device Authorization URL
            auth_url = f"https://accounts.x.ai/oauth2/device?user_code={user_code}"
            log_step(f"Membuka halaman otorisasi Grok CLI: {auth_url}")
            page.goto(auth_url, wait_until="networkidle", timeout=30000)
            
            wait_for_cf_clearance(page, timeout=15)
            
            log_step("Klik tombol Allow/Continue...")
            for btn_txt in ["Continue", "Allow", "Authorize", "Accept"]:
                try:
                    btn = page.locator(f"button:has-text('{btn_txt}')").first
                    if btn.count() > 0 and btn.is_visible(timeout=2000):
                        btn.click(timeout=5000)
                        log_step(f"Berhasil klik: {btn_txt}")
                        break
                except Exception:
                    pass
            
            time.sleep(5)
            
            # Step 5: Poll backend for token (since we clicked Allow)
            log_step("Polling token dari router (OAuth callback)...")
            token_found = False
            for _ in range(12):
                try:
                    poll_req = urllib.request.Request(f"http://127.0.0.1:20128/api/oauth/grok-cli/poll-status?device_code={device_code}", method="GET")
                    poll_req.add_header("x-9r-cli-token", "0202c5f8e7eb28ca")
                    with urllib.request.urlopen(poll_req, timeout=10) as r:
                        res = json.loads(r.read())
                    if res.get("ok"):
                        tok_data = res.get("data", {})
                        if "access_token" in tok_data:
                            emit({
                                "status": "success", 
                                "email": args.email, 
                                "api_key": tok_data["access_token"], 
                                "refresh_token": tok_data.get("refresh_token", ""),
                                "expires_in": tok_data.get("expires_in")
                            })
                            token_found = True
                            break
                except Exception:
                    pass
                time.sleep(5)
                
            if not token_found:
                die("Timeout saat polling token dari Router. Pastikan tombol Allow berhasil terklik.")

        except Exception as e:
            page.screenshot(path="/tmp/grok_error.png")
            die(f"Terjadi kesalahan automation: {str(e)}")

if __name__ == "__main__":
    main()