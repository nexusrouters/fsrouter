#!/usr/bin/env python3
"""Flashloop account auto-signup via Camoufox (anti-fingerprint) + Ammail email verification.

Referral code: UWZKVP (hardcoded in URL)

Outputs JSON lines to stdout:
  {"step": "..."} — progress update
  {"status": "success", "email": "...", "password": "..."} — final result
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

REFERRAL_CODE = "UWZKVP"
SIGNUP_URL = "https://www.flashloop.app/onboarding"

# ── Stdout JSON helpers ────────────────────────────────────────────────────────
def emit(obj):
    print(json.dumps(obj), flush=True)

def log_step(msg):
    emit({"step": msg})

def success(email, password):
    emit({"status": "success", "email": email, "password": password})

def die(msg):
    emit({"status": "error", "error": msg})
    sys.exit(1)

# ── Ammail helpers ─────────────────────────────────────────────────────────────
def ammail_request(base_url, api_key, path, method="GET", data=None):
    url = base_url.rstrip("/") + "/api" + path
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
    if data:
        req.data = json.dumps(data).encode()
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())

def create_ammail_inbox(base_url, api_key):
    """Create a random inbox and return (email, alias)."""
    rand = ''.join(random.choices(string.ascii_lowercase + string.digits, k=10))
    alias = f"fl{rand}"
    domain = None

    # Get available domains
    try:
        domains_data = ammail_request(base_url, api_key, "/domains")
        domains = domains_data.get("domains", [])
        if domains:
            domain = domains[0].get("name", domains[0].get("domain", ""))
    except Exception:
        pass

    if not domain:
        die("Tidak ada domain tersedia di Ammail")

    email = f"{alias}@{domain}"

    try:
        ammail_request(base_url, api_key, "/inboxes", method="POST",
                       data={"alias": alias, "domain": domain})
    except Exception as e:
        log_step(f"Warning: inbox creation: {e}")

    return email, alias

def wait_for_flashloop_email(base_url, api_key, alias, timeout=300):
    """Wait for Flashloop verification email and extract OTP code."""
    log_step(f"Menunggu email verifikasi Flashloop...")
    deadline = time.time() + timeout
    seen_ids = set()

    while time.time() < deadline:
        try:
            data = ammail_request(base_url, api_key, f"/inboxes/{urllib.parse.quote(alias)}/messages")
            messages = data.get("messages", [])
            for msg in messages:
                msg_id = msg.get("id", "")
                subject = msg.get("subject", "")
                if msg_id in seen_ids:
                    continue
                seen_ids.add(msg_id)

                subj_lower = subject.lower()
                is_flashloop = (
                    "flashloop" in subj_lower or
                    "verify" in subj_lower or
                    "confirm" in subj_lower or
                    "code" in subj_lower or
                    "otp" in subj_lower
                )
                if is_flashloop:
                    # Fetch full message
                    try:
                        full = ammail_request(base_url, api_key,
                                              f"/inboxes/{urllib.parse.quote(alias)}/messages/{urllib.parse.quote(msg_id)}")
                        body = full.get("body", "") or full.get("text", "") or full.get("html", "")

                        # Extract OTP code (usually 4-8 digits)
                        otp_match = re.search(r'\b(\d{4,8})\b', body)
                        if otp_match:
                            code = otp_match.group(1)
                            log_step(f"Kode verifikasi ditemukan: {code}")
                            return code

                        # Try extracting from subject
                        otp_subj = re.search(r'\b(\d{4,8})\b', subject)
                        if otp_subj:
                            code = otp_subj.group(1)
                            log_step(f"Kode verifikasi dari subject: {code}")
                            return code

                        # Try extracting verification link
                        link_match = re.search(r'https?://[^\s"<>]+verify[^\s"<>]*', body)
                        if not link_match:
                            link_match = re.search(r'https?://[^\s"<>]+confirm[^\s"<>]*', body)
                        if link_match:
                            link = link_match.group(0)
                            log_step(f"Link verifikasi ditemukan")
                            return {"type": "link", "url": link}

                        log_step(f"Email ditemukan tapi tidak bisa extract kode/link")
                        return body  # Return raw body for manual parsing
                    except Exception as e:
                        log_step(f"Error fetching message: {e}")
        except Exception:
            pass

        time.sleep(3)

    die("Timeout menunggu email verifikasi Flashloop")

# ── Password generator ─────────────────────────────────────────────────────────
def gen_password(length=14):
    chars = string.ascii_letters + string.digits + "!@#$%"
    while True:
        pwd = ''.join(random.choices(chars, k=length))
        if (any(c.isupper() for c in pwd) and
            any(c.islower() for c in pwd) and
            any(c.isdigit() for c in pwd)):
            return pwd

# ── Main ───────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--email", required=True)
    parser.add_argument("--password", required=True)
    parser.add_argument("--ammail-url", required=True)
    parser.add_argument("--ammail-key", required=True)
    parser.add_argument("--profiles-dir", required=True)
    parser.add_argument("--headless", action="store_true", default=True)
    parser.add_argument("--delay", type=float, default=0)
    args = parser.parse_args()

    if args.delay > 0:
        log_step(f"Delay {args.delay}s...")
        time.sleep(args.delay)

    email = args.email
    password = args.password
    alias = email.split("@")[0]
    log_step(f"Email: {email}")

    # Launch browser
    log_step("Meluncurkan browser...")
    try:
        from camoufox.sync_api import Camoufox
    except ImportError:
        die("Camoufox tidak terinstall. Jalankan: pip install camoufox && python -m camoufox fetch")

    launch_kwargs = dict(headless=args.headless, os="windows", locale="en-US")

    def _make_camoufox(kw):
        try:
            return Camoufox(**kw)
        except TypeError:
            kw.pop("os", None)
            try:
                return Camoufox(**kw)
            except TypeError:
                kw.pop("locale", None)
                return Camoufox(**kw)

    browser_ctx = _make_camoufox(dict(launch_kwargs))

    with browser_ctx as browser:
        page = browser.new_page()

        # Step 1: Go to signup page with referral code
        log_step("Membuka halaman signup Flashloop...")
        page.goto(SIGNUP_URL, wait_until="networkidle", timeout=30000)
        time.sleep(5)

        # Step 2: Click "Continue with Email"
        log_step("Klik 'Continue with Email'...")
        try:
            email_btn = page.locator('a:has-text("Continue with Email"), button:has-text("Continue with Email")').first
            email_btn.wait_for(timeout=15000)
            email_btn.click()
            time.sleep(2)
        except Exception as e:
            die(f"Tidak bisa klik 'Continue with Email': {e}")

        # Step 3: Fill signup form
        log_step("Mengisi form signup...")
        try:
            # Email field
            email_input = page.locator('input[placeholder*="Email"], input[type="email"], input[name="email"]').first
            email_input.wait_for(timeout=10000)
            email_input.fill(email)
            time.sleep(0.5)

            # Password field
            pwd_input = page.locator('input[placeholder*="Password"], input[type="password"], input[name="password"]').first
            pwd_input.fill(password)
            time.sleep(0.5)
        except Exception as e:
            die(f"Gagal mengisi form: {e}")

        # Step 4: Click "Create Account"
        log_step("Membuat akun...")
        try:
            create_btn = page.locator('button:has-text("Create Account"), button:has-text("Sign Up"), button:has-text("Register")').first
            create_btn.click()
            time.sleep(3)
        except Exception as e:
            die(f"Gagal klik 'Create Account': {e}")

        # Step 5: Handle post-signup (referral code + optional verification)
        log_step("Menunggu halaman setelah signup...")
        time.sleep(3)

        # Check for referral code input: "GOT A REFERRAL CODE?"
        try:
            page_text_lower = page.content().lower()
            if "referral" in page_text_lower or "bonus credits" in page_text_lower:
                log_step("Halaman referral terdeteksi, memasukkan kode UWZKVP...")
                # Try multiple locator strategies
                ref_input = None
                for selector in [
                    'input[placeholder*="referral" i]',
                    'input[placeholder*="code" i]',
                    'input[name*="referral" i]',
                    'input[name*="code" i]',
                    'input[type="text"]',
                    'input:not([type="password"]):not([type="hidden"]):not([type="email"])',
                ]:
                    try:
                        el = page.locator(selector).first
                        if el.is_visible(timeout=1000):
                            ref_input = el
                            break
                    except Exception:
                        continue

                if ref_input:
                    ref_input.fill(REFERRAL_CODE)
                    time.sleep(0.5)
                    # Try to find and click Apply Code button
                    for btn_text in ["Apply Code", "Apply", "Submit", "Continue"]:
                        try:
                            btn = page.locator(f'button:has-text("{btn_text}")').first
                            if btn.is_visible(timeout=1000):
                                btn.click()
                                log_step(f"Klik '{btn_text}' - kode referral diterapkan!")
                                break
                        except Exception:
                            continue
                    time.sleep(3)
                else:
                    log_step("Input referral tidak ditemukan, lanjut...")
        except Exception as e:
            log_step(f"Referral step tidak ditemukan atau sudah di-skip: {e}")

        # Check if already logged in (pricing page or dashboard)
        current_url = page.url
        if "pricing" in current_url or "dashboard" in current_url or "app" in current_url:
            log_step(f"Sudah masuk! URL: {current_url}")
            success(email, password)
        else:
            # Check for OTP input
            otp_inputs = page.locator('input[maxlength="1"], input[placeholder*="code"], input[placeholder*="Code"], input[type="tel"], input[name*="code"], input[name*="otp"]')

            if otp_inputs.count() > 0:
                log_step("Halaman OTP terdeteksi, menunggu kode dari email...")
                result = wait_for_flashloop_email(args.ammail_url, args.ammail_key, alias, timeout=120)

                if isinstance(result, dict) and result.get("type") == "link":
                    log_step("Membuka link verifikasi...")
                    page.goto(result["url"], wait_until="domcontentloaded", timeout=30000)
                    time.sleep(5)
                elif isinstance(result, str) and len(result) <= 8 and result.isdigit():
                    log_step(f"Memasukkan kode OTP: {result}")
                    inputs = page.locator('input[maxlength="1"], input[placeholder*="code"], input[type="tel"]')
                    for i, digit in enumerate(result):
                        if i < inputs.count():
                            inputs.nth(i).fill(digit)
                            time.sleep(0.2)
                    time.sleep(2)
                    try:
                        verify_btn = page.locator('button:has-text("Verify"), button:has-text("Confirm"), button:has-text("Submit")').first
                        verify_btn.click(timeout=5000)
                        time.sleep(3)
                    except Exception:
                        pass
                else:
                    log_step("Tidak ada kode verifikasi, lanjut...")
            else:
                log_step("Tidak ada OTP, menunggu sebentar...")
                time.sleep(5)

        # Final check
        log_step("Menunggu halaman akhir...")
        time.sleep(5)
        current_url = page.url
        log_step(f"URL akhir: {current_url}")

        if "onboarding" not in current_url or "login" not in current_url:
            success(email, password)
        else:
            die(f"Signup gagal. URL: {current_url}")

if __name__ == "__main__":
    main()
