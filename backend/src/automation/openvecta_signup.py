#!/usr/bin/env python3
"""OpenVecta account auto-signup via Camoufox (anti-fingerprint) + Fsmail email verification.

Flow:
  1. Navigate to openvecta.com → click "Get started"
  2. Privy modal opens → enter email → receive verification code via Fsmail
  3. Enter verification code → account created (Privy auto-creates Solana wallet)
  4. Navigate to dashboard → API keys tab → create new key
  5. Copy the ov_sk_live_... key

Outputs JSON lines to stdout:
  {"step": "..."} — progress update
  {"status": "success", "api_key": "ov_sk_live_...", "email": "..."} — final result
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


def success(api_key, email):
    emit({"status": "success", "api_key": api_key, "email": email})


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
    req.add_header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")
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
    """Create inbox by splitting email into alias + domain."""
    try:
        alias, domain = email.split("@", 1)
        fsmail_request(base_url, api_key, "/inboxes", method="POST",
                       data={"alias": alias, "domain": domain})
    except Exception:
        pass  # might already exist


def wait_for_openvecta_verify_email(base_url, api_key, email, timeout=300):
    """Wait for OpenVecta/Privy verification email and extract the code or link."""
    log_step(f"Menunggu email verifikasi OpenVecta ({email})...")
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
                is_ov_email = (
                    "openvecta" in subj_lower or
                    "privy" in subj_lower or
                    "verify" in subj_lower or
                    "confirm" in subj_lower or
                    "code" in subj_lower or
                    "login" in subj_lower or
                    "sign in" in subj_lower or
                    "magic" in subj_lower or
                    "verification" in subj_lower
                )
                if is_ov_email:
                    # Fetch full message body
                    try:
                        full = fsmail_request(base_url, api_key, f"/messages/{urllib.parse.quote(msg_id)}")
                        msg_body = full.get("message", full)
                        body = msg_body.get("body", msg_body.get("html", msg_body.get("text", "")))
                    except Exception:
                        body = msg.get("snippet", "")

                    # Look for verification link
                    link_patterns = [
                        r'https://auth\.privy\.io[^\s\'"<>]+',
                        r'https://openvecta\.com[^\s\'"<>]*verify[^\s\'"<>]*',
                        r'https://openvecta\.com[^\s\'"<>]*confirm[^\s\'"<>]*',
                        r'https://openvecta\.com[^\s\'"<>]*auth[^\s\'"<>]*',
                        r'https://[^\s\'"<>]*privy[^\s\'"<>]*',
                    ]
                    for pat in link_patterns:
                        links = re.findall(pat, body)
                        if links:
                            link = links[0].rstrip(".")
                            log_step(f"Link verifikasi ditemukan!")
                            return {"type": "link", "value": link}

                    # Look for verification code (typically 6 digits)
                    code_patterns = [
                        r'(?:code|otp|pin|verification)[:\s]*(\d{4,8})',
                        r'(\d{6})',
                        r'<strong[^>]*>(\d{4,8})</strong>',
                        r'<span[^>]*>(\d{6})</span>',
                        r'<h1[^>]*>(\d{6})</h1>',
                        r'<p[^>]*>\s*(\d{6})\s*</p>',
                    ]
                    for pat in code_patterns:
                        codes = re.findall(pat, body, re.IGNORECASE)
                        if codes:
                            code = codes[0].strip()
                            if len(code) >= 4:
                                log_step(f"Kode verifikasi ditemukan: {code}")
                                return {"type": "code", "value": code}

                    # If we found the email but no link/code, return the body for debugging
                    log_step(f"Email ditemukan tapi tidak ada link/kode yang bisa diekstrak")
                    return {"type": "unknown", "value": body[:500]}
        except Exception as e:
            log_step(f"Fsmail poll error: {e}")
        time.sleep(5)
    return None


# ── Human-like typing ──────────────────────────────────────────────────────────
def human_type(page, selector, text, delay_min=50, delay_max=150):
    """Type text with human-like delays."""
    el = page.locator(selector).first
    el.click()
    time.sleep(0.3)
    for char in text:
        el.type(char, delay=random.randint(delay_min, delay_max))
    time.sleep(0.5)


def safe_click(page, selector, timeout=10000):
    """Click element with retry."""
    try:
        el = page.locator(selector).first
        el.wait_for(state="visible", timeout=timeout)
        el.click()
        time.sleep(1)
        return True
    except Exception as e:
        log_step(f"Click failed ({selector}): {e}")
        return False


def wait_for_any(page, selectors, timeout=15000):
    """Wait for any of the selectors to appear, return the first matching selector."""
    deadline = time.time() + timeout / 1000
    while time.time() < deadline:
        for sel in selectors:
            try:
                el = page.locator(sel).first
                if el.count() > 0 and el.is_visible(timeout=500):
                    return sel
            except Exception:
                continue
        time.sleep(0.5)
    return None


# ── Main ───────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--email", required=True)
    parser.add_argument("--password", required=True, help="Used as placeholder, not for OpenVecta login")
    parser.add_argument("--fsmail-base-url", default="")
    parser.add_argument("--fsmail-api-key", default="")
    parser.add_argument("--fsmail-domain", default="")
    parser.add_argument("--profiles-dir", default="profiles/openvecta")
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--proxy-server")
    parser.add_argument("--proxy-user")
    parser.add_argument("--proxy-pass")
    parser.add_argument("--stagger-delay", type=int, default=0)
    args = parser.parse_args()

    email = args.email

    # Import Camoufox
    try:
        from camoufox.sync_api import Camoufox
    except ImportError:
        die("Camoufox tidak terinstall. Jalankan: pip install camoufox && python -m camoufox fetch")

    profiles_dir = Path(args.profiles_dir)
    profiles_dir.mkdir(parents=True, exist_ok=True)

    # Pre-create Fsmail inbox if we have credentials
    fsmail_ok = bool(args.fsmail_base_url and args.fsmail_api_key and args.fsmail_domain)
    if fsmail_ok:
        log_step(f"Membuat inbox Fsmail untuk {email}...")
        try:
            create_fsmail_inbox(args.fsmail_base_url, args.fsmail_api_key, email)
        except Exception as e:
            log_step(f"Fsmail inbox warning: {e}")

    log_step("Meluncurkan browser Camoufox (anti-fingerprint)...")

    if args.stagger_delay > 0:
        log_step(f"Stagger delay {args.stagger_delay}s...")
        time.sleep(args.stagger_delay)

    proxy_dict = None
    if args.proxy_server:
        proxy_dict = {"server": args.proxy_server}
        if args.proxy_user:
            proxy_dict["username"] = args.proxy_user
        if args.proxy_pass:
            proxy_dict["password"] = args.proxy_pass

    launch_kwargs = dict(
        headless=args.headless,
        os="windows",
        locale="en-US",
    )
    if proxy_dict:
        launch_kwargs["proxy"] = proxy_dict
        launch_kwargs["geoip"] = True

    def _make_camoufox(kw):
        """Launch Camoufox, stripping unsupported kwargs one by one."""
        try:
            return Camoufox(**kw)
        except TypeError:
            kw.pop("os", None)
            try:
                return Camoufox(**kw)
            except TypeError:
                kw.pop("locale", None)
                return Camoufox(**kw)

    try:
        browser_ctx = _make_camoufox(dict(launch_kwargs))
    except Exception as _pe:
        _ps = str(_pe)
        if proxy_dict and any(k in _ps for k in ("InvalidProxy", "Tunnel connection", "Failed to connect to proxy", "ProxyError")):
            log_step(f"Proxy dead ({proxy_dict.get('server', '?')}) — fallback tanpa proxy")
            launch_kwargs.pop("proxy", None)
            launch_kwargs.pop("geoip", None)
            browser_ctx = _make_camoufox(dict(launch_kwargs))
        else:
            raise

    with browser_ctx as browser:
        page = browser.new_page()

        try:
            # ── Step 1: Navigate to OpenVecta ─────────────────────────────────
            log_step("Membuka openvecta.com...")
            page.goto("https://openvecta.com", wait_until="domcontentloaded", timeout=30000)
            time.sleep(3)

            # ── Step 2: Click "Get started" to open Privy auth ────────────────
            log_step("Mencari tombol 'Get started'...")
            get_started = page.locator("button:has-text('Get started')").first
            get_started.wait_for(state="visible", timeout=15000)
            get_started.click()
            time.sleep(3)

            # ── Step 3: Handle Privy auth modal ───────────────────────────────
            log_step("Menunggu modal Privy auth...")

            # Privy modal may appear as an iframe or overlay
            # Try to find the email input in Privy modal
            privy_email_input = None

            # Method 1: Look for input in Privy iframe
            for attempt in range(3):
                frames = page.frames
                for frame in frames:
                    try:
                        url = frame.url or ""
                        if "privy" in url:
                            log_step(f"Frame Privy ditemukan: {url[:80]}")
                            email_input = frame.locator("input[type='email'], input[placeholder*='email' i], input[name='email']").first
                            if email_input.count() > 0:
                                privy_email_input = email_input
                                break
                    except Exception:
                        continue
                if privy_email_input:
                    break
                # Also check main page
                try:
                    email_input = page.locator("input[type='email'], input[placeholder*='email' i], input[name='email']").first
                    if email_input.count() > 0 and email_input.is_visible(timeout=2000):
                        privy_email_input = email_input
                        break
                except Exception:
                    pass
                time.sleep(2)

            if not privy_email_input:
                # Take screenshot for debugging
                try:
                    page.screenshot(path="/tmp/openvecta_no_privy.png")
                    log_step("Screenshot: /tmp/openvecta_no_privy.png")
                except Exception:
                    pass
                die("Tidak dapat menemukan input email Privy. Mungkin UI berubah.")

            # ── Step 4: Enter email in Privy ──────────────────────────────────
            log_step(f"Memasukkan email: {email}")
            privy_email_input.click()
            time.sleep(0.5)
            privy_email_input.fill("")
            time.sleep(0.3)
            # Type with human-like delays
            for char in email:
                privy_email_input.type(char, delay=random.randint(30, 80))
            time.sleep(1)

            # Click the submit/continue button
            log_step("Mengklik tombol submit...")
            # Look for submit button in the same context
            submit_clicked = False
            for frame in page.frames:
                try:
                    submit_btn = frame.locator("button[type='submit'], button:has-text('Continue'), button:has-text('Sign in'), button:has-text('Log in'), button:has-text('Submit')").first
                    if submit_btn.count() > 0 and submit_btn.is_visible(timeout=2000):
                        submit_btn.click()
                        submit_clicked = True
                        break
                except Exception:
                    continue

            if not submit_clicked:
                # Try main page
                try:
                    submit_btn = page.locator("button[type='submit'], button:has-text('Continue'), button:has-text('Sign in'), button:has-text('Log in')").first
                    if submit_btn.count() > 0:
                        submit_btn.click()
                        submit_clicked = True
                except Exception:
                    pass

            if not submit_clicked:
                # Try pressing Enter
                page.keyboard.press("Enter")

            time.sleep(3)

            # ── Step 5: Wait for verification code/link via Fsmail ────────────
            if not fsmail_ok:
                die("Fsmail credentials not provided. Cannot verify email.")

            verify_result = wait_for_openvecta_verify_email(
                args.fsmail_base_url, args.fsmail_api_key, email, timeout=300
            )

            if not verify_result:
                try:
                    page.screenshot(path="/tmp/openvecta_no_verify.png")
                    log_step("Screenshot: /tmp/openvecta_no_verify.png")
                except Exception:
                    pass
                die("Timeout menunggu email verifikasi OpenVecta.")

            # ── Step 6: Handle verification ───────────────────────────────────
            if verify_result["type"] == "link":
                log_step("Membuka link verifikasi...")
                page.goto(verify_result["value"], wait_until="domcontentloaded", timeout=30000)
                time.sleep(5)
            elif verify_result["type"] == "code":
                code = verify_result["value"]
                log_step(f"Memasukkan kode verifikasi: {code}")
                # Find code input fields (Privy typically has separate digit inputs or a single input)
                code_entered = False

                # Method 1: Single code input
                for frame in page.frames:
                    try:
                        code_input = frame.locator("input[type='text'], input[type='number'], input[type='tel'], input[inputmode='numeric']").first
                        if code_input.count() > 0 and code_input.is_visible(timeout=2000):
                            code_input.click()
                            code_input.fill(code)
                            code_entered = True
                            break
                    except Exception:
                        continue

                # Method 2: Multiple single-digit inputs (OTP style)
                if not code_entered:
                    for frame in page.frames:
                        try:
                            digit_inputs = frame.locator("input[maxlength='1']")
                            count = digit_inputs.count()
                            if count >= 4:
                                for i, digit in enumerate(code[:count]):
                                    if i < count:
                                        digit_inputs.nth(i).fill(digit)
                                        time.sleep(0.1)
                                code_entered = True
                                break
                        except Exception:
                            continue

                if not code_entered:
                    # Try main page
                    try:
                        code_input = page.locator("input[type='text'], input[type='number']").first
                        if code_input.count() > 0:
                            code_input.fill(code)
                            code_entered = True
                    except Exception:
                        pass

                time.sleep(3)

                # Click verify/submit button
                for frame in page.frames:
                    try:
                        verify_btn = frame.locator("button:has-text('Verify'), button:has-text('Confirm'), button:has-text('Submit'), button[type='submit']").first
                        if verify_btn.count() > 0 and verify_btn.is_visible(timeout=2000):
                            verify_btn.click()
                            break
                    except Exception:
                        continue

                time.sleep(5)
            else:
                log_step(f"Email ditemukan tapi format tidak dikenali: {str(verify_result['value'])[:200]}")

            # ── Step 7: Wait for dashboard to load ────────────────────────────
            log_step("Menunggu dashboard OpenVecta...")
            time.sleep(5)

            # Check if we need to navigate to dashboard
            current_url = page.url
            if "dashboard" not in current_url:
                log_step("Navigasi ke dashboard...")
                page.goto("https://openvecta.com/dashboard", wait_until="domcontentloaded", timeout=30000)
                time.sleep(5)

            # ── Step 8: Find API keys tab and create key ──────────────────────
            log_step("Mencari tab API keys...")

            # Look for API keys tab/button
            api_keys_clicked = False
            for selector in [
                "text=API keys",
                "text=API Keys",
                "text=Keys",
                "button:has-text('API')",
                "a:has-text('API keys')",
                "[data-tab='keys']",
                "text=api keys",
            ]:
                try:
                    el = page.locator(selector).first
                    if el.count() > 0 and el.is_visible(timeout=3000):
                        el.click()
                        api_keys_clicked = True
                        log_step(f"Tab API keys ditemukan dan diklik")
                        time.sleep(2)
                        break
                except Exception:
                    continue

            if not api_keys_clicked:
                log_step("Tab API keys tidak ditemukan, mencoba screenshot...")
                try:
                    page.screenshot(path="/tmp/openvecta_dashboard.png")
                    log_step("Screenshot: /tmp/openvecta_dashboard.png")
                except Exception:
                    pass

            # Click "Create key" button
            log_step("Mencari tombol 'Create key'...")
            create_clicked = False
            for selector in [
                "button:has-text('Create key')",
                "button:has-text('Create Key')",
                "button:has-text('Generate')",
                "button:has-text('New key')",
                "button:has-text('Add key')",
                "text=Create key",
                "text=Generate key",
            ]:
                try:
                    el = page.locator(selector).first
                    if el.count() > 0 and el.is_visible(timeout=3000):
                        el.click()
                        create_clicked = True
                        log_step("Tombol 'Create key' diklik")
                        time.sleep(3)
                        break
                except Exception:
                    continue

            if not create_clicked:
                try:
                    page.screenshot(path="/tmp/openvecta_no_create_btn.png")
                    log_step("Screenshot: /tmp/openvecta_no_create_btn.png")
                except Exception:
                    pass
                die("Tidak dapat menemukan tombol 'Create key'. Mungkin akun belum di-fund atau UI berubah.")

            # ── Step 9: Copy the generated API key ────────────────────────────
            log_step("Mengambil API key yang dihasilkan...")
            time.sleep(3)

            api_key = None

            # Method 1: Look for text matching ov_sk_ pattern on page
            try:
                page_text = page.content()
                ov_matches = re.findall(r'(ov_sk_live_[A-Za-z0-9_\-]{20,})', page_text)
                if ov_matches:
                    api_key = ov_matches[0]
                    log_step(f"API key ditemukan di halaman: {api_key[:20]}...")
            except Exception:
                pass

            # Method 2: Look in code/pre elements
            if not api_key:
                for selector in ["code", "pre", "[class*='key']", "[class*='token']", "[class*='secret']"]:
                    try:
                        el = page.locator(selector).first
                        if el.count() > 0:
                            text = el.text_content() or ""
                            ov_match = re.search(r'(ov_sk_live_[A-Za-z0-9_\-]{20,})', text)
                            if ov_match:
                                api_key = ov_match.group(1)
                                log_step(f"API key ditemukan di element {selector}")
                                break
                    except Exception:
                        continue

            # Method 3: Look for a copy button and read the nearby text
            if not api_key:
                for selector in [
                    "button:has-text('Copy')",
                    "button:has-text('copy')",
                    "[data-copy]",
                    "button[aria-label*='copy' i]",
                ]:
                    try:
                        copy_btn = page.locator(selector).first
                        if copy_btn.count() > 0 and copy_btn.is_visible(timeout=2000):
                            # Read sibling or parent text
                            parent = copy_btn.locator("xpath=..")
                            parent_text = parent.text_content() or ""
                            ov_match = re.search(r'(ov_sk_live_[A-Za-z0-9_\-]{20,})', parent_text)
                            if ov_match:
                                api_key = ov_match.group(1)
                                break
                            # Try grandparent
                            gparent = parent.locator("xpath=..")
                            gparent_text = gparent.text_content() or ""
                            ov_match = re.search(r'(ov_sk_live_[A-Za-z0-9_\-]{20,})', gparent_text)
                            if ov_match:
                                api_key = ov_match.group(1)
                                break
                    except Exception:
                        continue

            # Method 4: Try clipboard (click copy button and read clipboard)
            if not api_key:
                try:
                    copy_btn = page.locator("button:has-text('Copy')").first
                    if copy_btn.count() > 0:
                        copy_btn.click()
                        time.sleep(1)
                        # Try to read from clipboard via JS
                        clipboard = page.evaluate("() => navigator.clipboard.readText().catch(() => '')")
                        if clipboard and re.match(r'ov_sk_live_', clipboard):
                            api_key = clipboard
                except Exception:
                    pass

            # Method 5: Scan all text nodes for ov_sk_ pattern
            if not api_key:
                try:
                    all_text = page.evaluate("""
                        () => {
                            const walker = document.createTreeWalker(
                                document.body, NodeFilter.SHOW_TEXT, null, false
                            );
                            const texts = [];
                            let node;
                            while (node = walker.nextNode()) {
                                const t = node.textContent.trim();
                                if (t.includes('ov_sk_')) texts.push(t);
                            }
                            return texts;
                        }
                    """)
                    for text in (all_text or []):
                        ov_match = re.search(r'(ov_sk_live_[A-Za-z0-9_\-]{20,})', text)
                        if ov_match:
                            api_key = ov_match.group(1)
                            break
                except Exception:
                    pass

            if not api_key:
                try:
                    page.screenshot(path="/tmp/openvecta_no_key.png")
                    log_step("Screenshot: /tmp/openvecta_no_key.png")
                except Exception:
                    pass
                die("Tidak dapat menemukan API key ov_sk_live_... di halaman. Mungkin akun belum di-fund dengan USDC.")

            # ── Step 10: Return success ───────────────────────────────────────
            log_step(f"OpenVecta signup berhasil! API key: {api_key[:20]}...")
            success(api_key, email)

        except Exception as e:
            try:
                page.screenshot(path="/tmp/openvecta_error.png")
                log_step(f"Screenshot error: /tmp/openvecta_error.png")
            except Exception:
                pass
            die(f"Error selama otomatisasi OpenVecta: {str(e)}")


if __name__ == "__main__":
    main()
