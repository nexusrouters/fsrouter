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
from pathlib import Path
from camoufox.sync_api import Camoufox

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
    parser.add_argument("--stagger-delay", type=int, default=0)
    parser.add_argument("--proxy-server")
    parser.add_argument("--proxy-user")
    parser.add_argument("--proxy-pass")
    args = parser.parse_args()

    if args.fsmail_base_url and args.fsmail_api_key:
        create_fsmail_inbox(args.fsmail_base_url, args.fsmail_api_key, args.email)

    if args.stagger_delay > 0:
        log_step(f"Stagger delay {args.stagger_delay}s...")
        time.sleep(args.stagger_delay)

    # Build Camoufox launch kwargs
    launch_kwargs = {
        "headless": args.headless,
        "geoip": True,
    }
    if args.proxy_server:
        proxy_dict = {"server": args.proxy_server}
        if args.proxy_user:
            proxy_dict["username"] = args.proxy_user
        if args.proxy_pass:
            proxy_dict["password"] = args.proxy_pass
        launch_kwargs["proxy"] = proxy_dict

    def _make_camoufox(kwargs):
        if args.proxy_server:
            return Camoufox(**kwargs)
        return Camoufox(**kwargs)

    try:
        browser_ctx = _make_camoufox(launch_kwargs)
    except Exception as _pe:
        if args.proxy_server:
            log_step(f"Proxy fallback tanpa proxy ({args.proxy_server})")
            launch_kwargs.pop("proxy", None)
            launch_kwargs.pop("geoip", None)
            browser_ctx = _make_camoufox(launch_kwargs)
        else:
            raise

    with browser_ctx as browser:
        page = browser.new_page()
        page.set_viewport_size({"width": 1920, "height": 1080})

        # ── Step 1: Request device code + verification URL from the router ──────
        log_step("Request Device Code Grok CLI...")
        user_code = None
        device_code = None
        device_code_verifier = None
        verification_uri = None
        try:
            req = urllib.request.Request("http://127.0.0.1:20128/api/oauth/grok-cli/device-code", method="GET")
            req.add_header("x-9r-cli-token", "0202c5f8e7eb28ca")  # bypass auth locally
            with urllib.request.urlopen(req, timeout=10) as r:
                dc_res = json.loads(r.read())
            user_code = dc_res.get("user_code")
            device_code = dc_res.get("device_code")
            device_code_verifier = dc_res.get("codeVerifier")
            verification_uri = dc_res.get("verification_uri_complete") or dc_res.get("verification_uri")
            if not user_code:
                die("Gagal mendapatkan user_code dari router")
            log_step(f"Device Code Grok CLI didapatkan: {user_code}")
        except Exception as e:
            die(f"Gagal request device code: {e}")

        def fill_react(selector, value):
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

        # ── Step 2: Open verification URL (same as dashboard "Add") ─────────────
        # If the account is new, X.AI redirects to sign-up INSIDE THIS TAB, so the
        # session stays continuous (signup -> authorize in one flow).
        auth_url = verification_uri or f"https://accounts.x.ai/oauth2/device?user_code={user_code}"
        log_step(f"Membuka device verification URL: {auth_url}")
        try:
            page.goto(auth_url, wait_until="domcontentloaded", timeout=45000)
            wait_for_cf_clearance(page, timeout=30)
        except Exception as e:
            log_step(f"Goto device url error: {e}")

        # If redirected to sign-up, complete account creation in this same tab
        if "sign-up" in page.url:
            log_step("Redirect ke sign-up — selesaikan pendaftaran akun...")
            try:
                cb = page.locator("button#onetrust-accept-btn-handler, button#onetrust-reject-all-handler").first
                if cb.count() > 0 and cb.is_visible(timeout=3000):
                    cb.click(timeout=1000); time.sleep(1)
            except Exception:
                pass
            try:
                seb = page.locator("button:has-text('Sign up with email')").last
                if seb.count() > 0 and seb.is_visible(timeout=10000):
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
            except Exception as e:
                log_step(f"Signup form error: {e}")

        # ── Step 2B: OTP verification ───────────────────────────────────────────
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
            page.evaluate("""() => { const cb = document.querySelector('button#onetrust-accept-btn-handler'); if (cb) cb.click(); }""")
            time.sleep(0.5)
        except Exception:
            pass
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
        click_confirm_email()

        # ── Step 2C: Complete profile / password ───────────────────────────────
        log_step("Menunggu form pengisian password / profile baru...")
        try:
            page.wait_for_selector("input[type='password'], input[name='password']", timeout=25000)
        except Exception as e:
            try:
                cur_url = page.url
                page.screenshot(path="/tmp/grok_fail_state.png")
                btns = page.evaluate("""() => Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim()).filter(Boolean)""")
                inputs = page.evaluate("""() => Array.from(document.querySelectorAll('input')).map(i => i.name + ':' + i.type)""")
                log_step(f"DIAG url={cur_url} buttons={btns} inputs={inputs}")
            except Exception as de:
                log_step(f"DIAG error: {de}")
            die(f"Terjadi kesalahan automation: {e}")

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
        time.sleep(6)

        # ── Step 3: Authorize device (Continue) — back on the device page ───────
        log_step(f"Membuka halaman otorisasi Grok CLI: {auth_url}")
        page.goto(auth_url, wait_until="domcontentloaded", timeout=30000)
        wait_for_cf_clearance(page, timeout=15)
        time.sleep(3)
        log_step("Klik tombol Allow/Continue...")
        for btn_txt in ["Continue", "Allow", "Authorize", "Accept"]:
            try:
                btn = page.locator(f"button:has-text('{btn_txt}')").first
                if btn.count() > 0 and btn.is_visible(timeout=3000):
                    btn.click(timeout=5000)
                    log_step(f"Berhasil klik: {btn_txt}")
                    break
            except Exception:
                pass
        time.sleep(4)

        # If X.AI asks to sign in to authorize the device, log in (email-based)
        if "sign-in" in page.url or "login" in page.url.lower() or "google.com" in page.url:
            log_step("Device page minta login — login xAI...")
            try:
                if "google.com" in page.url:
                    try:
                        eo = page.locator("button:has-text('Sign in with email'), a:has-text('Use another account'), div:has-text('Sign in with email')").first
                        if eo.count() > 0 and eo.is_visible(timeout=3000):
                            eo.click(force=True, timeout=4000); time.sleep(2)
                    except Exception:
                        pass
                page.goto("https://accounts.x.ai/sign-in", wait_until="domcontentloaded", timeout=30000)
                time.sleep(3)
                try:
                    page.evaluate("""() => { const cb=document.querySelector('button#onetrust-accept-btn-handler'); if(cb) cb.click(); }""")
                    time.sleep(0.5)
                except Exception:
                    pass
                leb = page.locator("button:has-text('Login with email')").first
                if leb.count() > 0 and leb.is_visible(timeout=3000):
                    leb.click(force=True, timeout=5000); time.sleep(2)
                em = page.locator("input[type='email'], input[name='email'], input[type='text']").first
                if em.count() > 0 and em.is_visible(timeout=5000):
                    em.click(force=True); em.fill(args.email); time.sleep(1)
                pw = page.locator("input[type='password'], input[name='password']").first
                if pw.count() > 0 and pw.is_visible(timeout=5000):
                    pw.click(force=True); pw.fill(args.password); time.sleep(1)
                sub = page.locator("button[type='submit'], button:has-text('Login'), button:has-text('Log in'), button:has-text('Sign in')").first
                if sub.count() > 0 and sub.is_visible(timeout=3000):
                    sub.click(force=True, timeout=5000)
                else:
                    page.keyboard.press("Enter")
                time.sleep(5)
                log_step(f"After xAI login: {page.url}")
                page.goto(auth_url, wait_until="domcontentloaded", timeout=30000)
                wait_for_cf_clearance(page, timeout=15)
                time.sleep(3)
                for btn_txt in ["Continue", "Allow", "Authorize", "Accept"]:
                    try:
                        b2 = page.locator(f"button:has-text('{btn_txt}')").first
                        if b2.count() > 0 and b2.is_visible(timeout=3000):
                            b2.click(force=True, timeout=5000)
                            log_step(f"Re-klik device: {btn_txt}")
                            break
                    except Exception:
                        pass
            except Exception as le:
                log_step(f"Login device error: {le}")

        time.sleep(4)
        try:
            post_url = page.url
            page.screenshot(path="/tmp/grok_after_allow.png")
            log_step(f"DIAG after-allow url={post_url}")
        except Exception as de:
            log_step(f"DIAG after-allow error: {de}")

        # ── Step 5: Hand off to router for token exchange + persistence ─────────
        log_step("Menyerahkan device_code ke router untuk exchange token...")
        token_found = False
        for _ in range(36):
            try:
                pr = urllib.request.Request(
                    "http://127.0.0.1:20128/api/oauth/grok-cli/poll",
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
