#!/usr/bin/env python3
"""Cloudflare account auto-signup via Camoufox (anti-fingerprint) + Ammail email verification.

Outputs JSON lines to stdout:
  {"step": "..."} — progress update
  {"status": "success", "api_key": "...", "account_id": "...", "email": "..."} — final result
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

def success(api_key, account_id, email):
    # Clean api_key — extract Bearer token if it's a curl command
    import re as _re_clean
    bearer_match = _re_clean.search(r'Bearer\s+([A-Za-z0-9_\-]{20,})', api_key)
    if bearer_match:
        api_key = bearer_match.group(1)
    # Also match cfut_ token pattern directly
    cfut_match = _re_clean.search(r'\b(cfut_[A-Za-z0-9_\-]{30,})\b', api_key)
    if cfut_match:
        api_key = cfut_match.group(1)
    emit({"status": "success", "api_key": api_key, "account_id": account_id, "email": email})

def die(msg):
    emit({"status": "error", "error": msg})
    sys.exit(1)

# ── Ammail helpers ─────────────────────────────────────────────────────────────
def ammail_request(base_url, api_key, path, method="GET", data=None, host_header=None):
    url = base_url.rstrip("/") + "/api" + path
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("X-API-Key", api_key)
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")
    req.add_header("Accept", "application/json, */*")
    # Nginx vhost routing: tambah Host header jika base_url adalah localhost
    if host_header:
        req.add_header("Host", host_header)
    elif "localhost" in base_url or "127.0.0.1" in base_url:
        req.add_header("Host", "ammail.klipers.site")
    if data:
        req.data = json.dumps(data).encode()
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())

def create_ammail_inbox(base_url, api_key, email):
    """Create inbox by splitting email into alias + domain."""
    try:
        alias, domain = email.split("@", 1)
        ammail_request(base_url, api_key, "/inboxes", method="POST",
                       data={"alias": alias, "domain": domain})
    except Exception:
        pass  # might already exist

def wait_for_cf_verify_email(base_url, api_key, email, timeout=600):
    log_step(f"Menunggu email verifikasi Cloudflare ({email})...")
    alias = email.split("@")[0]
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
                # Broader subject matching — CF sometimes uses different subject lines
                subj_lower = subject.lower()
                is_cf_email = (
                    "cloudflare" in subj_lower or
                    "verify" in subj_lower or
                    "confirm" in subj_lower or
                    "email" in subj_lower or
                    "activate" in subj_lower or
                    "validate" in subj_lower
                )
                if is_cf_email:
                    # Fetch full message body
                    try:
                        full = ammail_request(base_url, api_key, f"/messages/{urllib.parse.quote(msg_id)}")
                        msg_body = full.get("message", full)
                        body = msg_body.get("body", msg_body.get("html", msg_body.get("text", "")))
                    except Exception:
                        body = msg.get("snippet", "")
                    patterns = [
                        r'https://dash\.cloudflare\.com/email-verification[^\s\'"<>]+',
                        r'https://[^\s\'"<>]*confirm[^\s\'"<>]*',
                        r'https://[^\s\'"<>]*verify[^\s\'"<>]*',
                        r'https://dash\.cloudflare\.com/[^\s\'"<>]+',
                    ]
                    for pat in patterns:
                        links = re.findall(pat, body)
                        if links:
                            link = links[0].rstrip(".")
                            log_step(f"Link verifikasi ditemukan!")
                            return link
        except Exception as e:
            log_step(f"Ammail poll error: {e}")
        time.sleep(5)
    return None

# ── 2Captcha Turnstile solver ───────────────────────────────────────────────────
# Hardcoded sitekey as fallback — scraping from page is preferred (see get_turnstile_sitekey)
CF_SIGNUP_TURNSTILE_SITEKEY = "0x4AAAAAAAJel0iaAR3mgkjp"
CF_SIGNUP_PAGE_URL = "https://dash.cloudflare.com/sign-up"

def get_turnstile_sitekey(page, fallback=CF_SIGNUP_TURNSTILE_SITEKEY):
    """Scrape the actual Turnstile sitekey from page — avoids hardcode becoming stale."""
    try:
        sitekey = page.evaluate(
            r"""
            () => {
                // Method 1: data-sitekey attribute
                const el = document.querySelector('[data-sitekey]');
                if (el) return el.getAttribute('data-sitekey');
                // Method 2: inside Turnstile iframe src
                for (const iframe of document.querySelectorAll('iframe')) {
                    const src = iframe.src || '';
                    const m = src.match(/[?&]sitekey=([^&]+)/);
                    if (m) return decodeURIComponent(m[1]);
                }
                // Method 3: window.__CF$cv$params
                try {
                    const raw = JSON.stringify(window.__CF$cv$params || {});
                    const m2 = raw.match(/sitekey["']?\s*:\s*["']([^"']+)["']/);
                    if (m2) return m2[1];
                } catch(e) {}
                return null;
            }
        """
        )
        if sitekey and len(sitekey.strip()) > 10:
            log_step(f"Sitekey dari halaman: {sitekey}")
            return sitekey.strip()
    except Exception as e:
        log_step(f"get_turnstile_sitekey error: {e}")
    log_step(f"Pakai sitekey hardcode: {fallback}")
    return fallback


def get_turnstile_action(page, default=None):
    """Extract data-action from Turnstile widget on page."""
    try:
        action = page.evaluate(r"""
            () => {
                // Method 1: data-action on cf-turnstile div
                const el = document.querySelector('[data-action], .cf-turnstile, [data-cf-turnstile-response]');
                if (el && el.getAttribute('data-action')) return el.getAttribute('data-action');
                // Method 2: scan iframe src for action param
                for (const iframe of document.querySelectorAll('iframe')) {
                    const src = iframe.src || '';
                    const m = src.match(/[?&]action=([^&]+)/);
                    if (m) return decodeURIComponent(m[1]);
                }
                return null;
            }
        """)
        if action:
            return action.strip()
    except Exception:
        pass
    return default


def solve_turnstile_2captcha(api_key, page_url, sitekey, timeout=120, action=None, data=None):
    """Submit Turnstile to 2Captcha and wait for solution token."""
    log_step("Mengirim Turnstile ke 2Captcha untuk diselesaikan...")
    try:
        # Submit task
        submit_data = {
            "key": api_key,
            "method": "turnstile",
            "sitekey": sitekey,
            "pageurl": page_url,
            "json": 1,
        }
        if action:
            submit_data["action"] = action
            log_step(f"2Captcha Turnstile action: {action}")
        if data:
            submit_data["data"] = data
        encoded = urllib.parse.urlencode(submit_data).encode()
        req = urllib.request.Request("https://2captcha.com/in.php", data=encoded)
        with urllib.request.urlopen(req, timeout=15) as r:
            resp = json.loads(r.read())
        if not resp.get("status") == 1:
            log_step(f"2Captcha submit error: {resp}")
            return None
        task_id = resp.get("request")
        log_step(f"2Captcha task submitted: {task_id}")

        # Poll for result
        deadline = time.time() + timeout
        time.sleep(15)  # initial wait
        while time.time() < deadline:
            res_url = f"https://2captcha.com/res.php?key={api_key}&action=get&id={task_id}&json=1"
            req2 = urllib.request.Request(res_url)
            with urllib.request.urlopen(req2, timeout=15) as r2:
                res = json.loads(r2.read())
            if res.get("status") == 1:
                token = res.get("request")
                log_step(f"2Captcha Turnstile solved!")
                return token
            if res.get("request") == "ERROR_CAPTCHA_UNSOLVABLE":
                log_step("2Captcha: captcha unsolvable")
                return None
            time.sleep(5)
        log_step("2Captcha Turnstile timeout")
        return None
    except Exception as e:
        log_step(f"2Captcha error: {e}")
        return None

def inject_turnstile_token(page, token):
    """Inject solved Turnstile token into the page."""
    try:
        page.evaluate(f"""
        (function() {{
            // Set cf-turnstile-response hidden input
            var inputs = document.querySelectorAll('input[name="cf-turnstile-response"], input[name="cf_challenge_response"]');
            inputs.forEach(function(el) {{ el.value = '{token}'; }});
            // Also try window.turnstile callback
            if (window.turnstile && window.turnstile.getResponse) {{
                try {{ window.turnstile.execute(); }} catch(e) {{}}
            }}
        }})();
        """)
        return True
    except Exception as e:
        log_step(f"inject_turnstile_token error: {e}")
        return False

# ── Turnstile bypass (ported from weavy_signup.py) ─────────────────────────────
def is_on_turnstile_page(page) -> bool:
    try:
        title = page.title() or ""
        if "just a moment" in title.lower() or "security verification" in title.lower():
            return True
    except Exception:
        pass
    try:
        token = page.evaluate("() => { const el = document.getElementsByName('cf-turnstile-response')[0] || document.getElementById('cf-turnstile-response'); return el ? el.value : null; }")
        if token is not None:
            return len(token.strip()) == 0
    except Exception:
        pass
    for sel in ["text=Just a moment", "text=Verifying you are human", "#challenge-form", "#cf-challenge-running"]:
        try:
            loc = page.locator(sel).first
            if loc.count() > 0 and loc.is_visible(timeout=300):
                return True
        except Exception:
            continue
    try:
        for f in page.frames:
            url = f.url or ""
            if ("challenges.cloudflare.com" in url or "turnstile" in url) and "challenge-platform" in url:
                token = page.evaluate("() => { const el = document.getElementsByName('cf-turnstile-response')[0]; return el ? el.value : ''; }")
                if token and len(token.strip()) > 0:
                    return False
                return True
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
                if box.count() > 0:
                    box.click(timeout=3000)
                    return True
            except Exception:
                continue
        try:
            handle = target_frame.frame_element()
            bbox = handle.bounding_box() if handle else None
            if bbox:
                x = bbox["x"] + 28
                y = bbox["y"] + 32
                page.mouse.move(x, y, steps=10)
                time.sleep(0.3)
                page.mouse.click(x, y)
                return True
        except Exception:
            pass
    for iframe_sel in ["iframe[src*='challenges.cloudflare.com']", "iframe[src*='turnstile']"]:
        for cb_sel in ["input[type='checkbox']", "[role='checkbox']"]:
            try:
                box = page.frame_locator(iframe_sel).locator(cb_sel).first
                if box.count() > 0:
                    box.click(timeout=3000)
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

# ── Cloudflare API ─────────────────────────────────────────────────────────────
CF_API = "https://api.cloudflare.com/client/v4"

def cf_api_call(path, global_key, email, method="GET", body=None):
    url = CF_API + path
    req = urllib.request.Request(url, method=method)
    req.add_header("X-Auth-Key", global_key)
    req.add_header("X-Auth-Email", email)
    req.add_header("Content-Type", "application/json")
    if body:
        req.data = json.dumps(body).encode()
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise Exception(f"CF API {path} {e.code}: {e.read().decode()}")

def get_account_id_via_api(global_key, email):
    try:
        r = cf_api_call("/accounts?per_page=1", global_key, email)
        if r.get("success") and r.get("result"):
            return r["result"][0]["id"], r["result"][0]["name"]
    except Exception as e:
        log_step(f"get_account_id error: {e}")
    return None, None

def create_workers_ai_token(global_key, email, account_id, token_name="9router Workers AI"):
    """Create Workers AI Read+Edit token via CF API using Global API Key."""
    try:
        # Get permission groups
        r = cf_api_call(f"/accounts/{account_id}/tokens/permission_groups", global_key, email)
        groups = r.get("result", [])
        # Exact match first: "Workers AI Read" not "Workers AI Metadata Read"
        def _match_wa(groups, keyword):
            # 1. exact match: name == "Workers AI <keyword>"
            exact = next((g for g in groups if g["name"].lower() == f"workers ai {keyword}"), None)
            if exact: return exact
            # 2. starts with "Workers AI " and ends with keyword (avoid Metadata)
            ends = next((g for g in groups if g["name"].lower().startswith("workers ai ") and
                         g["name"].lower().endswith(keyword) and "metadata" not in g["name"].lower()), None)
            if ends: return ends
            # 3. fallback: contains both keywords, exclude metadata
            return next((g for g in groups if "workers ai" in g["name"].lower() and
                         keyword in g["name"].lower() and "metadata" not in g["name"].lower()), None)
        read_g = _match_wa(groups, "read")
        edit_g = _match_wa(groups, "write") or _match_wa(groups, "edit")
        if not read_g or not edit_g:
            # fallback: use Write as both
            wa = [g for g in groups if "workers ai" in g["name"].lower() and "metadata" not in g["name"].lower()]
            if len(wa) >= 2:
                read_g, edit_g = wa[0], wa[1]
            elif len(wa) == 1:
                read_g = edit_g = wa[0]
            else:
                return None
        payload = {
            "name": token_name,
            "policies": [{
                "effect": "allow",
                "permission_groups": [{"id": read_g["id"]}, {"id": edit_g["id"]}],
                "resources": {f"com.cloudflare.api.account.{account_id}": "*"},
            }],
        }
        r2 = cf_api_call("/user/tokens", global_key, email, method="POST", body=payload)
        if r2.get("success") and r2.get("result", {}).get("value"):
            return r2["result"]["value"]
    except Exception as e:
        log_step(f"create_workers_ai_token error: {e}")
    return None

# ── Handle "Verify Your Identity" popup ────────────────────────────────────────
def handle_identity_verification(page, ammail_base_url, ammail_api_key, email):
    """Detect CF identity verification popup, send OTP, fetch from Ammail, submit."""
    try:
        # Use multiple selectors to detect the popup
        popup_visible = False
        for sel in [
            "h2:has-text('Verify Your Identity')",
            "h1:has-text('Verify Your Identity')",
            "div:has-text('Verify Your Identity')",
            "button:has-text('Send Verification Code')",
        ]:
            try:
                el = page.locator(sel).first
                if el.is_visible(timeout=2000):
                    popup_visible = True
                    break
            except Exception:
                continue

        if not popup_visible:
            return True  # No popup, all good

        log_step("Popup 'Verify Your Identity' terdeteksi!")

        # Click "Send Verification Code"
        send_btn = page.locator("button:has-text('Send Verification Code')").first
        if send_btn.is_visible(timeout=2000):
            send_btn.click()
            log_step("Klik Send Verification Code...")
            time.sleep(3)
        else:
            # Try clicking Cancel and skip
            cancel = page.locator("button:has-text('Cancel')").first
            if cancel.is_visible(timeout=1000):
                cancel.click()
            return False

        # Fetch OTP from Ammail
        if not ammail_base_url or not ammail_api_key:
            log_step("Ammail tidak dikonfigurasi, tidak bisa ambil OTP")
            return False

        log_step("Menunggu OTP di Ammail...")
        otp_code = None
        for attempt in range(20):  # 60 seconds
            time.sleep(3)
            try:
                msgs = ammail_request(ammail_base_url, ammail_api_key, f"/inboxes/{email.split('@')[0]}/messages")
                for msg in msgs.get("messages", []):
                    # Get full body
                    msg_detail = ammail_request(ammail_base_url, ammail_api_key, f"/messages/{msg['id']}")
                    body = msg_detail.get("body", "") or msg_detail.get("html", "") or msg.get("snippet", "")
                    # CF OTP is typically 6 digits
                    import re as _re
                    otp_match = _re.search(r'\b(\d{6})\b', body)
                    if otp_match:
                        otp_code = otp_match.group(1)
                        log_step(f"OTP ditemukan: {otp_code}")
                        break
            except Exception as e:
                log_step(f"Ammail OTP fetch error: {e}")
            if otp_code:
                break

        if not otp_code:
            log_step("OTP tidak diterima dalam 60 detik")
            return False

        # Enter OTP
        otp_input = page.locator("input[type='text'][maxlength='6'], input[placeholder*='code'], input[name*='code'], input[type='number']").first
        if otp_input.is_visible(timeout=5000):
            otp_input.fill(otp_code)
            time.sleep(0.5)
            log_step("OTP diisi!")

            # Submit
            for sel in ["button:has-text('Verify')", "button:has-text('Submit')", "button:has-text('Confirm')", "button[type='submit']"]:
                try:
                    btn = page.locator(sel).first
                    if btn.is_visible(timeout=1000):
                        btn.click()
                        time.sleep(2)
                        log_step("OTP submitted!")
                        return True
                except Exception:
                    continue
        else:
            log_step("OTP input field tidak ditemukan")
    except Exception as e:
        log_step(f"handle_identity_verification error: {e}")
    return False

# ── Extract Global API Key from dashboard page ─────────────────────────────────
def extract_global_api_key(page, password, ammail_base_url="", ammail_api_key="", email=""):
    """Navigate to API tokens page and extract Global API Key."""
    log_step("Membuka halaman API Tokens...")
    try:
        page.goto("https://dash.cloudflare.com/profile/api-tokens", wait_until="domcontentloaded", timeout=30000)
        wait_for_cf_clearance(page, timeout=20)
        time.sleep(3)

        # ── Handle "Verify Your Identity" popup ─────────────────────────────
        handle_identity_verification(page, ammail_base_url, ammail_api_key, email)
        time.sleep(1)

        # Find "View" button for Global API Key
        view_selectors = [
            "button:has-text('View')",
            "button:has-text('Reveal')",
            "span:has-text('View'):visible",
        ]
        for sel in view_selectors:
            try:
                btn = page.locator(sel).first
                if btn.is_visible(timeout=2000):
                    btn.click()
                    time.sleep(1)
                    break
            except Exception:
                continue

        # Password confirmation modal
        pw_input = page.locator("input[type='password']").first
        if pw_input.is_visible(timeout=3000):
            log_step("Mengisi password konfirmasi...")
            pw_input.evaluate("""
                (el, pw) => {
                    const nativeSetter = Object.getOwnPropertyDescriptor(
                        window.HTMLInputElement.prototype, 'value'
                    ).set;
                    nativeSetter.call(el, pw);
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                }
            """, password)
            time.sleep(0.5)
            # Click confirm button
            for sel in ["button:has-text('View')", "button[type='submit']", "button:has-text('Confirm')"]:
                try:
                    btn = page.locator(sel).last
                    if btn.is_visible(timeout=1000):
                        btn.click()
                        break
                except Exception:
                    continue
            time.sleep(2)

        # Extract the key value
        for sel in [
            "input[data-testid='global-api-key']",
            "input[readonly][type='text']",
            "code",
            ".cf-input-code",
            "input[class*='code']",
            "input[class*='api']",
        ]:
            try:
                el = page.locator(sel).first
                if el.is_visible(timeout=2000):
                    val = el.input_value() if sel.startswith("input") else el.text_content()
                    if val and len(val) > 20:
                        return val.strip()
            except Exception:
                continue

        # Take screenshot to debug
        try:
            page.screenshot(path="/tmp/cf_api_key_page.png")
            log_step("Screenshot saved: /tmp/cf_api_key_page.png")
        except Exception:
            pass

    except Exception as e:
        log_step(f"extract_global_api_key error: {e}")
    return None

# ── Main ───────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--email", required=True)
    parser.add_argument("--password", required=True)
    parser.add_argument("--ammail-base-url", default="")
    parser.add_argument("--ammail-api-key", default="")
    parser.add_argument("--ammail-domain", default="")
    parser.add_argument("--profiles-dir", default="profiles/cloudflare")
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--proxy-server")
    parser.add_argument("--proxy-user")
    parser.add_argument("--proxy-pass")
    parser.add_argument("--2captcha-key", default="", dest="captcha_key")
    # ── Manual override: skip automation, paste token directly ────────────────
    parser.add_argument("--token", default="",
                        help="Paste CF API token manual — skip seluruh automation")
    parser.add_argument("--account-id", default="", dest="account_id_arg",
                        help="Cloudflare Account ID (wajib jika pakai --token)")
    parser.add_argument("--stagger-delay", type=int, default=0, dest="stagger_delay",
                        help="Delay (detik) sebelum launch browser, untuk stagger concurrent instances")
    args = parser.parse_args()

    # ── Shortcut: jika user paste token manual, langsung simpan ──────────────
    if args.token:
        if not args.account_id_arg:
            die("--token butuh --account-id juga")
        log_step(f"Mode manual token: {args.token[:12]}...")
        success(args.token.strip(), args.account_id_arg.strip(), args.email)
        return

    # Import Camoufox (same as weavy_signup.py)
    try:
        from camoufox.sync_api import Camoufox
    except ImportError:
        die("Camoufox tidak terinstall. Jalankan: pip install camoufox && python -m camoufox fetch")

    profiles_dir = Path(args.profiles_dir)
    profiles_dir.mkdir(parents=True, exist_ok=True)

    # Pre-create Ammail inbox if we have credentials
    ammail_ok = bool(args.ammail_base_url and args.ammail_api_key and args.ammail_domain)
    if ammail_ok:
        log_step(f"Membuat inbox Ammail untuk {args.email}...")
        try:
            create_ammail_inbox(args.ammail_base_url, args.ammail_api_key, args.email)
        except Exception as e:
            log_step(f"Ammail inbox warning: {e}")

    log_step("Meluncurkan browser Camoufox (anti-fingerprint)...")

    # Stagger delay — when running concurrent instances, delay launch to avoid
    # resource contention and Cloudflare rate-limit detection
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
        launch_kwargs["geoip"] = True  # match geolocation to proxy IP (suppresses LeakWarning)

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
        if proxy_dict and any(k in _ps for k in ("InvalidProxy","Tunnel connection","Failed to connect to proxy","ProxyError")):
            log_step(f"Proxy dead ({proxy_dict.get('server','?')}) — fallback tanpa proxy")
            launch_kwargs.pop("proxy", None)
            launch_kwargs.pop("geoip", None)
            browser_ctx = _make_camoufox(dict(launch_kwargs))
        else:
            raise

    with browser_ctx as browser:
        page = browser.new_page()
        page.set_viewport_size({"width": 1920, "height": 1080})

        # ── Step 1: Open Cloudflare signup ────────────────────────────────────
        log_step("Membuka halaman registrasi Cloudflare...")
        try:
            page.goto("https://dash.cloudflare.com/sign-up", wait_until="domcontentloaded", timeout=30000)
        except Exception:
            page.goto("https://dash.cloudflare.com/sign-up", wait_until="load", timeout=30000)

        wait_for_cf_clearance(page, timeout=30)
        time.sleep(random.uniform(1.5, 2.5))

        # ── Step 2: Fill email ────────────────────────────────────────────────
        log_step("Menunggu form signup muncul...")
        form_found = False
        for attempt in range(3):
            try:
                page.wait_for_selector("input[name='email'], input[autocomplete='email']", timeout=20000)
                form_found = True
                break
            except Exception:
                log_step(f"Form belum muncul (attempt {attempt+1}), reload...")
                try:
                    page.reload(wait_until="load", timeout=20000)
                    wait_for_cf_clearance(page, timeout=15)
                    time.sleep(3)
                except Exception:
                    pass
        if not form_found:
            die("Form signup tidak muncul setelah 3 percobaan")

        log_step("Mengisi email...")
        email_sel = [
            "input[name='email']",
            "input[autocomplete='email']",
            "input[type='email']",
        ]
        email_filled = False
        for sel in email_sel:
            try:
                el = page.locator(sel).first
                if el.is_visible(timeout=2000):
                    el.evaluate("""
                        (el, email) => {
                            const nativeSetter = Object.getOwnPropertyDescriptor(
                                window.HTMLInputElement.prototype, 'value'
                            ).set;
                            nativeSetter.call(el, email);
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    """, args.email)
                    email_filled = True
                    break
            except Exception:
                continue
        if not email_filled:
            die("Tidak bisa menemukan input email di halaman signup Cloudflare")

        # ── Step 3: Fill password ─────────────────────────────────────────────
        log_step("Mengisi password...")
        pw_inputs = page.locator("input[name='password'], input[type='password']")
        pw_count = pw_inputs.count()
        
        def fill_password_field(el, password, retries=3):
            """Fill password field with React-compatible injection + verification."""
            for attempt in range(retries):
                try:
                    # Method 1: React-compatible JS injection (most reliable for React forms)
                    el.evaluate("""
                        (el, pw) => {
                            const nativeSetter = Object.getOwnPropertyDescriptor(
                                window.HTMLInputElement.prototype, 'value'
                            ).set;
                            nativeSetter.call(el, pw);
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                            el.dispatchEvent(new Event('blur', { bubbles: true }));
                        }
                    """, password)
                    time.sleep(0.3)
                    
                    # Verify
                    actual = el.evaluate("el => el.value")
                    if actual == password:
                        log_step(f"Password set via React injection OK (attempt {attempt+1})")
                        return True
                    
                    log_step(f"React injection mismatch (attempt {attempt+1}): expected {len(password)}, got {len(actual)}")
                    
                    # Method 2: type() as fallback
                    el.click()
                    el.press("Control+a")
                    el.press("Backspace")
                    time.sleep(0.1)
                    el.type(password, delay=50)
                    time.sleep(0.5)
                    actual2 = el.evaluate("el => el.value")
                    if actual2 == password:
                        log_step(f"Password set via type() OK (attempt {attempt+1})")
                        return True
                    
                    log_step(f"type() mismatch (attempt {attempt+1}): expected {len(password)}, got {len(actual2)}")
                except Exception as e:
                    log_step(f"Fill password attempt {attempt+1} error: {e}")
            return False
        
        if pw_count >= 1:
            ok1 = fill_password_field(pw_inputs.nth(0), args.password)
            if not ok1:
                log_step("WARNING: Password field 0 could not be verified")
        if pw_count >= 2:
            ok2 = fill_password_field(pw_inputs.nth(1), args.password)
            if not ok2:
                log_step("WARNING: Password field 1 (confirm) could not be verified")

        # ── Step 4: Handle Turnstile ──────────────────────────────────────────
        log_step("Menangani Turnstile captcha...")
        time.sleep(3)

        # First try auto-solve with retry — checks both cf_challenge_response and cf-turnstile-response
        turnstile_solved = False
        for _ts_attempt in range(3):
            wait_for_cf_clearance(page, timeout=10)
            try:
                token_val = page.evaluate("""
                    () => {
                        const names = ['cf-turnstile-response', 'cf_challenge_response', 'cf-turnstile-response-0'];
                        for (const n of names) {
                            const el = document.querySelector(`input[name="${n}"]`) || document.getElementById(n);
                            if (el && el.value && el.value.length > 10) return el.value;
                        }
                        return '';
                    }
                """)
                if token_val and len(token_val.strip()) > 10:
                    turnstile_solved = True
                    log_step(f"Turnstile auto-solved! (attempt {_ts_attempt+1})")
                    break
            except Exception:
                pass
            if _ts_attempt < 2:
                time.sleep(3)

        # Scrape actual sitekey from page (not hardcode)
        actual_sitekey = get_turnstile_sitekey(page)

        # Fallback: 2Captcha
        if not turnstile_solved and args.captcha_key:
            log_step("Turnstile belum solved, pakai 2Captcha...")
            token_2c = solve_turnstile_2captcha(
                args.captcha_key,
                CF_SIGNUP_PAGE_URL,
                actual_sitekey,
                timeout=150,
            )
            if token_2c:
                inject_turnstile_token(page, token_2c)
                turnstile_solved = True
                time.sleep(1)
            else:
                log_step("2Captcha gagal, tetap coba submit...")
        elif not turnstile_solved:
            log_step("Tidak ada 2Captcha key, lanjut submit tanpa solve...")

        # ── Step 5: Submit form ───────────────────────────────────────────────
        log_step("Submit form registrasi...")
        submit_selectors = [
            "button[type='submit']",
            "button:has-text('Create Account')",
            "button:has-text('Sign up')",
            "button:has-text('Get started')",
        ]
        submitted = False
        for sel in submit_selectors:
            try:
                btn = page.locator(sel).first
                if btn.is_visible(timeout=2000):
                    # React-compatible click: dispatch mouse events
                    btn.evaluate("""
                        (el) => {
                            // Focus first
                            el.focus();
                            el.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}));
                            el.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, cancelable: true}));
                            el.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
                        }
                    """)
                    submitted = True
                    log_step(f"Submit button clicked via: {sel}")
                    break
            except Exception:
                continue
        if not submitted:
            # Try form.submit() as fallback
            try:
                page.evaluate("""
                    () => {
                        const form = document.querySelector('form');
                        if (form) {
                            form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
                            return 'form dispatched';
                        }
                        // Try clicking ANY visible button
                        const btns = Array.from(document.querySelectorAll('button'));
                        for (const b of btns) {
                            const txt = b.textContent.trim().toLowerCase();
                            if (txt.includes('create') || txt.includes('sign up') || txt.includes('get started') || txt.includes('register')) {
                                b.click();
                                return 'clicked: ' + txt;
                            }
                        }
                        return 'no button found';
                    }
                """)
                submitted = True
                log_step("Submit via form.submit() or JS fallback")
            except Exception as e:
                die(f"Tidak bisa menemukan tombol submit registrasi: {e}")

        # Wait longer and check if URL changed
        time.sleep(5)
        post_submit_url = page.url
        log_step(f"Post-submit URL: {post_submit_url}")

        # If still on signup page, try pressing Enter on password field
        if "/sign-up" in post_submit_url or "/register" in post_submit_url:
            log_step("Masih di signup page, coba Enter di password field...")
            try:
                pw_el = page.locator("input[type='password']").first
                if pw_el.is_visible(timeout=2000):
                    pw_el.press("Enter")
                    time.sleep(5)
                    log_step(f"After Enter URL: {page.url}")
            except Exception:
                pass

        # If STILL on signup page, try dispatching form submit event directly
        if "/sign-up" in page.url or "/register" in page.url:
            log_step("Masih di signup page setelah Enter, coba force submit...")
            try:
                page.evaluate("""
                    () => {
                        const forms = document.querySelectorAll('form');
                        for (const form of forms) {
                            // Try native submit
                            try { HTMLFormElement.prototype.submit.call(form); } catch(e) {}
                        }
                        // Try clicking submit button via native click
                        const btn = document.querySelector('button[type="submit"]');
                        if (btn) {
                            HTMLButtonElement.prototype.click.call(btn);
                        }
                    }
                """)
                time.sleep(5)
                log_step(f"After force submit URL: {page.url}")
            except Exception:
                pass

        time.sleep(3)

        # Check for errors (email already registered, etc.)
        # Use JS to get all visible text — catch any wording CF uses
        email_already_registered = False
        try:
            page_text_lower = page.evaluate("document.body.innerText").lower()
            log_step(f"Post-signup page snippet: {page_text_lower[:200]}")
            # Only treat as already-registered if CF explicitly says so
            already_kw = [
                "already registered", "already exists", "already in use",
                "already taken", "account exists", "email exists",
                "sudah terdaftar",
                "email address is already",
                # NOTE: "already have an account?" is NOT here — it's just the
                # normal sign-in link on CF's signup page, not an error message
            ]
            for kw in already_kw:
                if kw in page_text_lower:
                    log_step(f"Email sudah terdaftar ({args.email}) — detected: '{kw}'")
                    email_already_registered = True
                    break
        except Exception as e:
            log_step(f"Post-signup check error: {e}")

        # Detect success: "check your email" / verify message
        signup_success_verify = False
        try:
            success_kw = ["check your email", "verify your email", "verification email", "link has been sent", "email sent", "confirmation link"]
            if any(kw in page_text_lower for kw in success_kw):
                signup_success_verify = True
                log_step("Signup sukses: CF meminta verifikasi email")
        except Exception:
            pass

        # If signup not detected as success, wait longer — CF may still be processing
        if not signup_success_verify and not email_already_registered:
            log_step("Signup status unclear — waiting 10s for CF to redirect...")
            for _sw in range(5):
                time.sleep(2)
                _cur_url = page.url
                # Any URL change away from signup/login = success
                if 'dash.cloudflare.com/login' not in _cur_url and 'dash.cloudflare.com/sign-up' not in _cur_url and 'dash.cloudflare.com' in _cur_url:
                    log_step(f"CF redirect detected after signup: {_cur_url[:60]}")
                    signup_success_verify = True
                    break
                # Also re-check body text
                try:
                    _recheck = page.evaluate("document.body.innerText").lower()
                    if any(kw in _recheck for kw in ["check your email", "verify your email", "verification email"]):
                        signup_success_verify = True
                        log_step("Signup sukses terdeteksi (delayed)")
                        break
                    if any(kw in _recheck for kw in ["already registered", "already exists", "email exists"]):
                        email_already_registered = True
                        log_step("Email sudah terdaftar (delayed detect)")
                        break
                except Exception:
                    pass
            if not signup_success_verify and not email_already_registered:
                log_step(f"Signup state masih unclear setelah wait. URL: {page.url[:80]}")

        if email_already_registered:
            # Navigate FRESH to /login (don't carry stale security_token from verify link)
            # Use try/except — CF SPA can abort domcontentloaded with NS_BINDING_ABORTED
            for _goto_attempt in range(3):
                try:
                    page.goto("https://dash.cloudflare.com/login",
                              wait_until="domcontentloaded", timeout=30000)
                    break
                except Exception as _ge:
                    if "NS_BINDING_ABORTED" in str(_ge) or "net::ERR_ABORTED" in str(_ge):
                        log_step(f"Login goto aborted (attempt {_goto_attempt+1}), retry with commit...")
                        try:
                            page.wait_for_load_state("domcontentloaded", timeout=10000)
                            break
                        except Exception:
                            time.sleep(2)
                    else:
                        log_step(f"Login goto error: {_ge}")
                        break
            time.sleep(3)



        # ── Step 6: Email verification ────────────────────────────────────────
        if ammail_ok and not email_already_registered:
            verify_link = wait_for_cf_verify_email(
                args.ammail_base_url,
                args.ammail_api_key,
                args.email,
                timeout=240,
            )
            if verify_link:
                log_step(f"Membuka link verifikasi...")
                try:
                    page.goto(verify_link, wait_until="domcontentloaded", timeout=30000)
                    wait_for_cf_clearance(page, timeout=20)
                    # Wait for CF SPA to execute email verification API call
                    try:
                        page.wait_for_load_state("networkidle", timeout=15000)
                    except Exception:
                        pass
                    time.sleep(5)  # extra wait for React verification to complete
                    _vurl = page.url
                    _vbody = ""
                    try:
                        _vbody = page.evaluate("document.body.innerText").lower()[:200]
                    except Exception:
                        pass
                    log_step(f"After verify link — URL: {_vurl[:80]}, body: {_vbody[:150]}")
                except Exception as e:
                    log_step(f"Warning navigasi verify link: {e}")

            else:
                log_step("Email verifikasi tidak diterima dalam 2 menit, lanjut coba login...")
        elif email_already_registered:
            log_step("Email sudah terdaftar — skip verifikasi, langsung ke login form")
        else:
            log_step("Ammail tidak dikonfigurasi — skip email verification, lanjut login manual...")
            time.sleep(5)


        # ── Step 7: Login if needed ───────────────────────────────────────────
        # After verify link, CF might already redirect to dashboard
        _early_account_id = ""
        _post_verify_url = page.url
        _m_verify = re.search(r"/(?:home/)?([a-f0-9]{32})(?:/|$)", _post_verify_url)
        if _m_verify:
            _early_account_id = _m_verify.group(1)
            log_step(f"Sudah di dashboard setelah verify! Account ID: {_early_account_id[:8]}...")
        else:
            log_step("Login ke Cloudflare Dashboard...")
            try:
                for _goto_attempt2 in range(3):
                    try:
                        page.goto("https://dash.cloudflare.com/login",
                                  wait_until="domcontentloaded", timeout=20000)
                        break
                    except Exception as _ge2:
                        if "NS_BINDING_ABORTED" in str(_ge2) or "net::ERR_ABORTED" in str(_ge2):
                            log_step(f"Login goto aborted (attempt {_goto_attempt2+1}), wait for load...")
                            try:
                                page.wait_for_load_state("domcontentloaded", timeout=10000)
                                break
                            except Exception:
                                time.sleep(2)
                        else:
                            raise
                time.sleep(2)

                # Check if already redirected to dashboard
                _m_redir = re.search(r"/(?:home/)?([a-f0-9]{32})(?:/|$)", page.url)
                if _m_redir:
                    _early_account_id = _m_redir.group(1)
                    log_step(f"Redirect otomatis ke dashboard: {_early_account_id[:8]}...")
                else:
                    # Wait for login form
                    try:
                        page.wait_for_selector("input[name='email'], input[autocomplete='email']", timeout=8000)
                    except Exception:
                        log_step("Login form tidak muncul, cek URL...")
                        _m2 = re.search(r"/(?:home/)?([a-f0-9]{32})(?:/|$)", page.url)
                        if _m2:
                            _early_account_id = _m2.group(1)

                    if not _early_account_id:
                        # Take screenshot to see login page state
                        page.screenshot(path="/tmp/cf_login_page.png")

                        # Screenshot login page state
                        page.screenshot(path="/tmp/cf_login_state.png")

                        # Diagnostic: log all inputs on login page
                        try:
                            login_inputs = page.evaluate("""
                                () => Array.from(document.querySelectorAll('input')).map(i => ({
                                    type: i.type, name: i.name, id: i.id,
                                    autocomplete: i.autocomplete, placeholder: i.placeholder,
                                    visible: i.offsetParent !== null
                                }))
                            """)
                            log_step(f"Login page inputs: {login_inputs}")
                        except Exception as e:
                            log_step(f"Login inputs diagnostic: {e}")

                        # CF login — 2-step flow (email → Continue → password → Sign in)
                        # Step A: Fill email
                        email_filled = False
                        for sel in [
                            "input[name='email']",
                            "input[type='email']",
                            "input[autocomplete='email']",
                            "input[autocomplete='username']",
                            "input[id*='email' i]",
                            "input[placeholder*='email' i]",
                            "form input:not([type='password']):not([type='hidden']):not([type='checkbox'])",
                        ]:
                            try:
                                el = page.locator(sel).first
                                if el.count() > 0 and el.is_visible(timeout=2000):
                                    el.evaluate("""
                                        (el, email) => {
                                            const nativeSetter = Object.getOwnPropertyDescriptor(
                                                window.HTMLInputElement.prototype, 'value'
                                            ).set;
                                            nativeSetter.call(el, email);
                                            el.dispatchEvent(new Event('input', { bubbles: true }));
                                            el.dispatchEvent(new Event('change', { bubbles: true }));
                                        }
                                    """, args.email)
                                    email_filled = True
                                    log_step(f"Login email filled via: {sel}")
                                    break
                            except Exception as ex:
                                log_step(f"Login email try {sel}: {type(ex).__name__}")
                                continue

                        if not email_filled:
                            log_step("Email field not found on login page")
                            page.screenshot(path="/tmp/cf_login_noemail.png")

                        # Step B: Click Continue/Next (2-step flow) or fill password directly (1-step)
                        # First, try to find a Continue/Next button
                        continue_clicked = False
                        for cont_sel in [
                            "button:has-text('Continue')",
                            "button:has-text('Next')",
                            "button[type='submit']:not(:has-text('Sign')):not(:has-text('Log'))",
                            "input[type='submit']",
                        ]:
                            try:
                                btn = page.locator(cont_sel).first
                                if btn.count() > 0 and btn.is_visible(timeout=1500):
                                    # Check if password field is NOT visible (2-step)
                                    pw_check = page.locator("input[type='password']")
                                    if pw_check.count() == 0 or not pw_check.first.is_visible(timeout=500):
                                        btn.click()
                                        continue_clicked = True
                                        log_step(f"Clicked Continue via: {cont_sel}")
                                        time.sleep(3)
                                        break
                            except Exception:
                                continue

                        # Step C: Fill password (after Continue in 2-step, or directly in 1-step)
                        pw_filled = False
                        def fill_login_pw(el, password, retries=3):
                            """Fill login password with React-compatible injection + verification."""
                            for attempt in range(retries):
                                try:
                                    # Method 1: React-compatible JS injection
                                    el.evaluate("""
                                        (el, pw) => {
                                            const nativeSetter = Object.getOwnPropertyDescriptor(
                                                window.HTMLInputElement.prototype, 'value'
                                            ).set;
                                            nativeSetter.call(el, pw);
                                            el.dispatchEvent(new Event('input', { bubbles: true }));
                                            el.dispatchEvent(new Event('change', { bubbles: true }));
                                            el.dispatchEvent(new Event('blur', { bubbles: true }));
                                        }
                                    """, password)
                                    time.sleep(0.3)
                                    actual = el.evaluate("el => el.value")
                                    if actual == password:
                                        log_step(f"Login password set via React injection OK (attempt {attempt+1})")
                                        return True
                                    log_step(f"React injection mismatch (attempt {attempt+1}): expected {len(password)}, got {len(actual)}")
                                    
                                    # Method 2: type() as fallback
                                    el.click()
                                    el.press("Control+a")
                                    el.press("Backspace")
                                    time.sleep(0.1)
                                    el.type(password, delay=50)
                                    time.sleep(0.5)
                                    actual2 = el.evaluate("el => el.value")
                                    if actual2 == password:
                                        log_step(f"Login password set via type() OK (attempt {attempt+1})")
                                        return True
                                    log_step(f"type() mismatch (attempt {attempt+1}): expected {len(password)}, got {len(actual2)}")
                                except Exception as e:
                                    log_step(f"Fill login pw attempt {attempt+1} error: {e}")
                            return False

                        for pw_sel in [
                            "input[type='password']",
                            "input[name='password']",
                            "input[autocomplete='current-password']",
                            "input[autocomplete='new-password']",
                        ]:
                            try:
                                pw_el = page.locator(pw_sel).first
                                if pw_el.count() > 0 and pw_el.is_visible(timeout=5000):
                                    if fill_login_pw(pw_el, args.password):
                                        pw_filled = True
                                        break
                            except Exception:
                                continue

                        if not pw_filled:
                            # Maybe email page had no Continue — try submit first then fill password
                            log_step("Password field not visible, trying submit first...")
                            for sel in ["button[type='submit']", "button:has-text('Sign in')", "button:has-text('Log in')", "button:has-text('Continue')", "button:has-text('Next')"]:
                                try:
                                    btn = page.locator(sel).first
                                    if btn.count() > 0 and btn.is_visible(timeout=1000):
                                        btn.click()
                                        break
                                except Exception:
                                    continue
                            time.sleep(3)
                            # Try password field again
                            for pw_sel in [
                                "input[type='password']",
                                "input[name='password']",
                            ]:
                                try:
                                    pw_el = page.locator(pw_sel).first
                                    if pw_el.count() > 0 and pw_el.is_visible(timeout=5000):
                                        if fill_login_pw(pw_el, args.password):
                                            pw_filled = True
                                            break
                                except Exception:
                                    continue
                            if not pw_filled:
                                log_step("Password field not found")
                                page.screenshot(path="/tmp/cf_login_nopw.png")

                        # Solve Turnstile (if any appeared after filling form)
                        wait_for_cf_clearance(page, timeout=3)
                        try_click_turnstile_checkbox(page)
                        time.sleep(1)

                        # DEBUG: screenshot after password fill, before submit
                        page.screenshot(path="/tmp/cf_before_submit.png")
                        try:
                            pw_val = page.evaluate("""
                                () => {
                                    const pw = document.querySelector('input[type="password"]');
                                    return pw ? { len: pw.value.length, type: pw.type, name: pw.name } : 'no pw field';
                                }
                            """)
                            log_step(f"Before submit - PW field: {pw_val}")
                        except Exception:
                            pass


                        # Check if auto-solved, else try 2Captcha
                        login_turnstile_solved = False
                        try:
                            token_val = page.evaluate("() => { const el = document.getElementsByName('cf_challenge_response')[0]; return el ? el.value : ''; }")
                            if token_val and len(token_val.strip()) > 10:
                                login_turnstile_solved = True
                                log_step("Turnstile login auto-solved!")
                        except Exception:
                            pass

                        if not login_turnstile_solved and args.captcha_key:
                            log_step("Solve Turnstile login via 2Captcha...")
                            login_sitekey = get_turnstile_sitekey(page)
                            login_token = solve_turnstile_2captcha(
                                args.captcha_key,
                                "https://dash.cloudflare.com/login",
                                login_sitekey,
                                timeout=150,
                            )
                            if login_token:
                                inject_turnstile_token(page, login_token)
                                login_turnstile_solved = True
                                time.sleep(1)
                                log_step("Turnstile login injected via 2Captcha!")

                        # Submit
                        for sel in ["button[type='submit']", "button:has-text('Sign in')", "button:has-text('Log in')"]:
                            try:
                                btn = page.locator(sel).first
                                if btn.is_visible(timeout=1000):
                                    btn.click()
                                    break
                            except Exception:
                                continue

                        log_step("Menunggu redirect ke dashboard...")
                        time.sleep(10)
                        page.screenshot(path="/tmp/cf_after_login_submit.png")

                        current_url = page.url
                        log_step(f"After login URL: {current_url}")
                        
                        # Debug: dump password field value before checking
                        try:
                            pw_debug = page.evaluate("""
                                () => {
                                    const pw = document.querySelector('input[type="password"]');
                                    return pw ? { exists: true, value_len: pw.value.length, type: pw.type } : { exists: false };
                                }
                            """)
                            log_step(f"PW field after submit: {pw_debug}")
                        except Exception:
                            pass
                        
                        # Check page content for ANY error (not just "login" in URL)
                        try:
                            err_txt = page.evaluate("document.body.innerText")
                            log_step(f"Page text (first 500): {err_txt[:500]}")
                            
                            # Detect wrong password
                            login_fail_kw = [
                                "incorrect email or password",
                                "invalid email or password",
                                "wrong password",
                                "email or password is incorrect",
                                "authentication failed",
                            ]
                            if any(kw in err_txt.lower() for kw in login_fail_kw):
                                page.screenshot(path="/tmp/cf_login_wrong_pw.png")
                                die(f"Login gagal: password salah untuk {args.email}. Akun CF ini mungkin sudah ada dengan password berbeda.")
                            
                            # Detect other errors (rate limit, captcha, etc)
                            other_errors = [
                                "too many attempts",
                                "try again later",
                                "blocked",
                                "suspended",
                                "captcha",
                                "challenge",
                            ]
                            if any(kw in err_txt.lower() for kw in other_errors):
                                log_step(f"Login blocked by other error: {[kw for kw in other_errors if kw in err_txt.lower()]}")
                        except SystemExit:
                            raise
                        except Exception:
                            pass
                        
                        # If still on login page but no explicit error, it might be a captcha/challenge issue
                        if "/login" in current_url or "/challenge" in current_url:
                            page.screenshot(path="/tmp/cf_login_stuck.png")
                            log_step(f"Still on login/challenge page: {current_url}")
                        
                        _m_after = re.search(r"(?:home/)?([a-f0-9]{32})(?:/|$)", current_url)
                        if _m_after:
                            _early_account_id = _m_after.group(1)
                            log_step(f"Account ID from login URL: {_early_account_id[:8]}...")

            except SystemExit:
                raise
            except Exception as e:
                log_step(f"Login error: {e}")

        # ── Step 8: Get to dashboard and extract account ID ───────────────────
        account_id = ""

        # Method 0: from login URL (already captured above)
        if _early_account_id:
            account_id = _early_account_id
            log_step(f"Account ID (from login): {account_id[:8]}...")

        # Method 1: from current page URL — ANY 32-hex in the path (not just /home/)
        if not account_id:
            try:
                for _ in range(5):
                    url_match = re.search(r"/([a-f0-9]{32})(?:/|$)", page.url)
                    if url_match:
                        account_id = url_match.group(1)
                        log_step(f"Account ID from URL: {account_id[:8]}...")
                        break
                    time.sleep(1)
            except Exception as e:
                log_step(f"account_id from URL error: {e}")

        # Method 2: CF API /accounts via page.request.fetch
        if not account_id:
            try:
                log_step("Method 2: CF /accounts via page.request.fetch...")
                api_resp = page.request.fetch(
                    "https://api.cloudflare.com/client/v4/accounts?per_page=50",
                    method="GET",
                    headers={"Accept": "application/json"}
                )
                log_step(f"CF /accounts status: {api_resp.status}")
                if api_resp.status == 200:
                    data = api_resp.json()
                    if data.get("success") and data.get("result"):
                        for acct in data["result"]:
                            if acct.get("id") and len(acct["id"]) == 32:
                                account_id = acct["id"]
                                log_step(f"Account ID via API: {account_id[:8]}...")
                                break
                else:
                    log_step(f"CF /accounts response: {api_resp.text()[:200]}")
            except Exception as e:
                log_step(f"Method 2 error: {e}")

        # Method 3: Extract browser cookies → use Python requests to call CF API
        if not account_id:
            try:
                log_step("Method 3: Extract cookies → Python requests to CF API...")
                cookies = page.context.cookies()
                cookie_str = "; ".join(f"{c['name']}={c['value']}" for c in cookies)
                if cookie_str:
                    import requests as _req
                    for _retry in range(3):
                        try:
                            r = _req.get(
                                "https://api.cloudflare.com/client/v4/accounts?per_page=50",
                                headers={
                                    "Cookie": cookie_str,
                                    "Accept": "application/json",
                                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                                },
                                timeout=15
                            )
                            log_step(f"Python CF /accounts status: {r.status_code}")
                            if r.status_code == 200:
                                data = r.json()
                                if data.get("success") and data.get("result"):
                                    for acct in data["result"]:
                                        if acct.get("id") and len(acct["id"]) == 32:
                                            account_id = acct["id"]
                                            log_step(f"Account ID via Python API: {account_id[:8]}...")
                                            break
                            if account_id:
                                break
                        except Exception as e:
                            log_step(f"Python API retry {_retry+1}: {e}")
                        time.sleep(2)
                else:
                    log_step("Method 3: No cookies found")
            except Exception as e:
                log_step(f"Method 3 error: {e}")

        # Method 4: Navigate to /profile/api-tokens → has account_id in URL
        if not account_id:
            try:
                log_step("Method 4: Navigate to /profile/api-tokens...")
                page.goto("https://dash.cloudflare.com/profile/api-tokens", wait_until="domcontentloaded", timeout=30000)
                for _ in range(10):
                    time.sleep(1)
                    m = re.search(r"/([a-f0-9]{32})(?:/|$)", page.url)
                    if m:
                        account_id = m.group(1)
                        log_step(f"Account ID from api-tokens URL: {account_id[:8]}...")
                        break
                if not account_id:
                    log_step(f"api-tokens final URL: {page.url}")
            except Exception as e:
                log_step(f"Method 4 error: {e}")

        # Method 5: Navigate to home → wait for redirect with account_id
        if not account_id:
            try:
                log_step("Method 5: Navigate to / → wait for account_id redirect...")
                page.goto("https://dash.cloudflare.com/", wait_until="domcontentloaded", timeout=30000)
                for _ in range(15):
                    time.sleep(1)
                    m = re.search(r"/([a-f0-9]{32})(?:/|$)", page.url)
                    if m:
                        account_id = m.group(1)
                        log_step(f"Account ID from / redirect: {account_id[:8]}...")
                        break
                if not account_id:
                    log_step(f"/ redirect final URL: {page.url}")
                    page.screenshot(path="/tmp/cf_no_account_id.png")
            except Exception as e:
                log_step(f"Method 5 error: {e}")

        # Method 6: Extract from JS page state (deep search)
        if not account_id:
            try:
                log_step("Method 6: Deep JS search for account_id...")
                page.goto("https://dash.cloudflare.com/", wait_until="domcontentloaded", timeout=20000)
                time.sleep(5)
                account_id = page.evaluate("""
                () => {
                    // Deep search window objects
                    const candidates = [
                        window.__INITIAL_STATE__, window.__cf_data__,
                        window.__BOOTSTRAP_DATA__, window.__NEXT_DATA__,
                        window.__APP_STATE__,
                    ];
                    for (const obj of candidates) {
                        if (!obj) continue;
                        const search = (o, depth) => {
                            if (depth > 5 || !o || typeof o !== 'object') return null;
                            for (const [k, v] of Object.entries(o)) {
                                if (k === 'account_id' || k === 'accountId') {
                                    if (typeof v === 'string' && /^[a-f0-9]{32}$/.test(v)) return v;
                                }
                                if (typeof v === 'object' && v !== null) {
                                    const found = search(v, depth + 1);
                                    if (found) return found;
                                }
                            }
                            return null;
                        };
                        const found = search(obj, 0);
                        if (found) return found;
                    }
                    // Check cookies
                    const cookies = document.cookie.split(';');
                    for (const c of cookies) {
                        const m = c.match(/account_id=([a-f0-9]{32})/);
                        if (m) return m[1];
                    }
                    // Check localStorage
                    try {
                        for (let i = 0; i < localStorage.length; i++) {
                            const key = localStorage.key(i);
                            const val = localStorage.getItem(key);
                            if (val) {
                                const m = val.match(/"account_id"\\s*:\\s*"([a-f0-9]{32})"/);
                                if (m) return m[1];
                            }
                        }
                    } catch(e) {}
                    return '';
                }
                """)
                if account_id and len(account_id) == 32:
                    log_step(f"Account ID from JS: {account_id[:8]}...")
                else:
                    account_id = ""
                    log_step("Method 6: account_id not found")
            except Exception as e:
                log_step(f"Method 6 error: {e}")

        # Method 7: CF API /memberships endpoint (different from /accounts — may work when /accounts fails)
        if not account_id:
            try:
                log_step("Method 7: CF /memberships via page.request.fetch...")
                mem_resp = page.request.fetch(
                    "https://api.cloudflare.com/client/v4/user/memberships?per_page=50",
                    method="GET",
                    headers={"Accept": "application/json"}
                )
                log_step(f"CF /memberships status: {mem_resp.status}")
                if mem_resp.status == 200:
                    mem_data = mem_resp.json()
                    if mem_data.get("success") and mem_data.get("result"):
                        for membership in mem_data["result"]:
                            org = membership.get("organization", {}) or {}
                            org_id = org.get("id", "")
                            # Also check membership.account.id
                            acct = membership.get("account", {}) or {}
                            acct_id = acct.get("id", "")
                            for candidate in [org_id, acct_id]:
                                if candidate and len(candidate) == 32 and re.match(r'^[a-f0-9]{32}$', candidate):
                                    account_id = candidate
                                    log_step(f"Account ID via memberships: {account_id[:8]}...")
                                    break
                            if account_id:
                                break
            except Exception as e:
                log_step(f"Method 7 error: {e}")

        # Method 8: CF API /memberships via Python requests with browser cookies
        if not account_id:
            try:
                log_step("Method 8: /memberships via Python requests + cookies...")
                cookies = page.context.cookies()
                cookie_str = "; ".join(f"{c['name']}={c['value']}" for c in cookies)
                if cookie_str:
                    import requests as _req2
                    for _retry in range(2):
                        try:
                            r = _req2.get(
                                "https://api.cloudflare.com/client/v4/user/memberships?per_page=50",
                                headers={
                                    "Cookie": cookie_str,
                                    "Accept": "application/json",
                                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                                },
                                timeout=15
                            )
                            log_step(f"Python /memberships status: {r.status_code}")
                            if r.status_code == 200:
                                data = r.json()
                                if data.get("success") and data.get("result"):
                                    for membership in data["result"]:
                                        acct = membership.get("account", {}) or {}
                                        acct_id = acct.get("id", "")
                                        if acct_id and len(acct_id) == 32 and re.match(r'^[a-f0-9]{32}$', acct_id):
                                            account_id = acct_id
                                            log_step(f"Account ID via Python memberships: {account_id[:8]}...")
                                            break
                            if account_id:
                                break
                        except Exception as e:
                            log_step(f"Python memberships retry {_retry+1}: {e}")
                        time.sleep(2)
            except Exception as e:
                log_step(f"Method 8 error: {e}")

        # Method 9: Deep JS scan — search ALL window properties and global state for account_id
        if not account_id:
            try:
                log_step("Method 9: Deep JS scan ALL global objects...")
                page.goto("https://dash.cloudflare.com/", wait_until="domcontentloaded", timeout=20000)
                time.sleep(6)
                account_id = page.evaluate("""
                () => {
                    // Broader search: look in ALL window properties
                    const hex32 = /^[a-f0-9]{32}$/;
                    // Check common CF state containers
                    const stateNames = [
                        '__INITIAL_STATE__', '__cf_data__', '__BOOTSTRAP_DATA__',
                        '__NEXT_DATA__', '__APP_STATE__', '__cf_context__',
                        'cfData', 'CFData', '__CF$', 'analytics',
                    ];
                    const deepSearch = (obj, depth, path) => {
                        if (depth > 8 || !obj) return null;
                        if (typeof obj === 'string' && hex32.test(obj) && path.toLowerCase().includes('account')) return obj;
                        if (typeof obj === 'string' && hex32.test(obj)) return obj; // any 32-hex in deep state
                        if (Array.isArray(obj)) {
                            for (let i = 0; i < Math.min(obj.length, 10); i++) {
                                const r = deepSearch(obj[i], depth+1, path+'['+i+']');
                                if (r) return r;
                            }
                        }
                        if (typeof obj === 'object' && obj !== null) {
                            for (const [k, v] of Object.entries(obj)) {
                                if (k === 'account_id' || k === 'accountId' || k === 'account') {
                                    if (typeof v === 'string' && hex32.test(v)) return v;
                                    if (typeof v === 'object' && v !== null) {
                                        if (v.id && hex32.test(v.id)) return v.id;
                                        const r = deepSearch(v, depth+1, path+'.'+k);
                                        if (r) return r;
                                    }
                                }
                                if (typeof v === 'object' && v !== null) {
                                    const r = deepSearch(v, depth+1, path+'.'+k);
                                    if (r) return r;
                                }
                            }
                        }
                        return null;
                    };
                    for (const name of stateNames) {
                        try {
                            const obj = window[name];
                            if (obj) {
                                const r = deepSearch(obj, 0, name);
                                if (r) return r;
                            }
                        } catch(e) {}
                    }
                    // Also scan all script tags for account_id patterns
                    try {
                        const scripts = Array.from(document.querySelectorAll('script'));
                        for (const s of scripts) {
                            const txt = s.textContent || '';
                            const m = txt.match(/"account_id"\\s*:\\s*"([a-f0-9]{32})"/);
                            if (m) return m[1];
                            const m2 = txt.match(/"accountId"\\s*:\\s*"([a-f0-9]{32})"/);
                            if (m2) return m2[1];
                        }
                    } catch(e) {}
                    return '';
                }
                """)
                if account_id and len(account_id) == 32:
                    log_step(f"Account ID from deep JS scan: {account_id[:8]}...")
                else:
                    account_id = ""
                    log_step("Method 9: account_id not found")
            except Exception as e:
                log_step(f"Method 9 error: {e}")

        # ── Step 9/10: Buat Workers AI Token via Session API ─────────────────
        global_key = None
        workers_ai_token = None

        if not account_id:
            # Last-chance: try /accounts one more time via page.evaluate (sends cookies natively)
            try:
                log_step("Last-chance account_id: page.evaluate fetch /accounts...")
                _lc_result = page.evaluate("""
                    async () => {
                        try {
                            const r = await fetch('https://api.cloudflare.com/client/v4/accounts?per_page=50', {
                                credentials: 'include',
                                headers: {'Accept': 'application/json'}
                            });
                            const d = await r.json();
                            if (d.success && d.result && d.result.length > 0) {
                                return d.result[0].id;
                            }
                            // Also try /memberships
                            const r2 = await fetch('https://api.cloudflare.com/client/v4/user/memberships?per_page=50', {
                                credentials: 'include',
                                headers: {'Accept': 'application/json'}
                            });
                            const d2 = await r2.json();
                            if (d2.success && d2.result) {
                                for (const m of d2.result) {
                                    const id = (m.account && m.account.id) || (m.organization && m.organization.id) || '';
                                    if (id && /^[a-f0-9]{32}$/.test(id)) return id;
                                }
                            }
                        } catch(e) { return ''; }
                        return '';
                    }
                """)
                if _lc_result and len(_lc_result) == 32 and re.match(r'^[a-f0-9]{32}$', _lc_result):
                    account_id = _lc_result
                    log_step(f"Account ID from last-chance fetch: {account_id[:8]}...")
            except Exception as e:
                log_step(f"Last-chance account_id error: {e}")

        if not account_id:
            die("Tidak bisa membuat API Token: account_id tidak ditemukan")

        log_step("Membuat Workers AI API Token...")

        # ── Strategy A: Get Global API Key → create token via CF API ────────────
        # Capture ammail vars into local scope for nested function closure
        _ammail_base_url = args.ammail_base_url or ""
        _ammail_api_key = args.ammail_api_key or ""

        def create_token_via_global_key(page):
            """Navigate to API Keys page, get Global API Key, use CF API to create token."""
            import requests as _req
            log_step("Mencoba ambil Global API Key dari dashboard...")
            try:
                # Navigate to API keys page — CF React SPA takes time to mount.
                # Retry navigate + wait up to 3x if still showing loading spinner.
                for _nav_attempt in range(3):
                    page.goto("https://dash.cloudflare.com/profile/api-tokens", wait_until="domcontentloaded", timeout=25000)
                    # Wait for actual content (not just loading spinner)
                    _page_ready = False
                    for _wait_sel in [
                        "text=Global API Key",
                        "button:has-text('View')",
                        "h1, h2, h3, [role='heading']",
                    ]:
                        try:
                            page.wait_for_selector(_wait_sel, timeout=12000)
                            log_step(f"API tokens page ready via: {_wait_sel}")
                            _page_ready = True
                            break
                        except Exception:
                            continue
                    if _page_ready:
                        break
                    log_step(f"API tokens page not ready (attempt {_nav_attempt+1}), retry...")
                    time.sleep(3)

                time.sleep(2)
                page.screenshot(path="/tmp/cf_gak_page.png")
                _pg_txt = page.inner_text("body")
                _gidx = _pg_txt.find("Global")
                log_step(f"GAK page: {_pg_txt[_gidx:_gidx+200] if _gidx >= 0 else _pg_txt[:200]}")

                # Scroll to bottom to reveal Global API Key section
                page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                time.sleep(2)

                # Intercept CF API response to capture Global API Key from network
                _intercepted_key = []
                _captcha_challenge = {}  # captures context=apikey challenge response
                def _on_gak_response(resp):
                    try:
                        url = resp.url
                        if 'cloudflare.com/api' in url or '/api/v4/' in url:
                            log_step(f"CF API call: {resp.status} {url[-80:]}")
                        # Capture challenge token issued by CF (needed for GAK POST)
                        if 'captcha/challenge' in url and 'context=apikey' in url and resp.status == 200:
                            try:
                                body = resp.json()
                                log_step(f"GAK captcha/challenge body: {str(body)[:400]}")
                                _captcha_challenge.update(body.get('result', {}) or {})
                            except Exception as _ce:
                                log_step(f"captcha/challenge parse error: {_ce}")
                        # Log full body for user/api_key
                        if 'user/api_key' in url:
                            try:
                                body = resp.json()
                                log_step(f"GAK api_key {resp.status} body: {str(body)[:400]}")
                                if resp.status == 200:
                                    result = body.get('result', {}) or {}
                                    key = (result.get('api_key') or result.get('key') or
                                           result.get('value') or result.get('global_key') or '')
                                    if key and len(key) > 20:
                                        log_step(f"GAK key from api_key 200: {key[:12]}...")
                                        _intercepted_key.append(key)
                            except Exception as _re:
                                log_step(f"GAK api_key body error: {_re}")
                            return
                        if resp.status == 200 and ('api_key' in url or 'global_key' in url or
                                'user/api' in url or 'verify' in url):
                            try:
                                body = resp.json()
                                result = body.get('result', {}) or {}
                                key = (result.get('api_key') or result.get('key') or
                                       result.get('value') or result.get('global_key') or '')
                                if not key:
                                    for v in (result.values() if isinstance(result, dict) else []):
                                        if isinstance(v, str) and len(v) > 30:
                                            key = v; break
                                if key and len(key) > 20:
                                    log_step(f"GAK intercepted ({url[-40:]}): {key[:12]}...")
                                    _intercepted_key.append(key)
                            except Exception:
                                pass
                    except Exception:
                        pass
                page.on("response", _on_gak_response)

                # Click on "Global API Key" > "View" button
                view_clicked = False
                for sel in ["button:has-text('View')", "a:has-text('View')"]:
                    try:
                        b = page.locator(sel).first
                        if b.count() > 0 and b.is_visible(timeout=3000):
                            b.click()
                            time.sleep(2)
                            log_step(f"Clicked View Global API Key via: {sel}")
                            view_clicked = True
                            break
                    except Exception:
                        continue
                if not view_clicked:
                    _btns = page.evaluate("Array.from(document.querySelectorAll('button')).filter(b=>b.offsetParent).map(b=>b.innerText.trim()).filter(t=>t).slice(0,30)")
                    log_step(f"View not found. Visible buttons: {_btns}")

                # CF shows "Verify Your Identity" modal — click Send Verification Code → enter OTP from email
                try:
                    send_btn = page.locator("button:has-text('Send Verification Code')").first
                    if send_btn.count() > 0 and send_btn.is_visible(timeout=3000):
                        send_btn.click()
                        time.sleep(2)
                        log_step("Sent verification code for Global API Key")

                        # Record existing message IDs before sending to skip stale OTPs
                        seen_msg_ids = set()
                        try:
                            pre_msgs = ammail_request(_ammail_base_url, _ammail_api_key,
                                f"/inboxes/{urllib.parse.quote(args.email.split('@')[0])}/messages")
                            pre_list = pre_msgs.get("messages", []) if isinstance(pre_msgs, dict) else (pre_msgs if isinstance(pre_msgs, list) else [])
                            seen_msg_ids = {str(m.get('id', '')) for m in pre_list}
                            log_step(f"Pre-existing msgs: {len(seen_msg_ids)}")
                        except Exception: pass

                        # Poll ammail for the OTP (36 × 5s = 3 minutes)
                        otp_code = None
                        for _poll_i in range(36):
                            time.sleep(5)
                            log_step(f"OTP poll {_poll_i+1}/36...")

                            try:
                                msgs_resp = ammail_request(_ammail_base_url, _ammail_api_key,
                                                      f"/inboxes/{urllib.parse.quote(args.email.split('@')[0])}/messages")
                                # ammail_request returns dict {"messages": [...]} not a list directly
                                msgs_list = msgs_resp.get("messages", []) if isinstance(msgs_resp, dict) else (msgs_resp if isinstance(msgs_resp, list) else [])
                                for msg in msgs_list:
                                    mid = str(msg.get('id', ''))
                                    # Skip pre-existing messages (stale OTPs)
                                    if mid in seen_msg_ids:
                                        continue
                                    if 'cloudflare' in str(msg.get('from', '')).lower() or 'cloudflare' in str(msg.get('subject', '')).lower():
                                        import re as _re_otp
                                        # Strategy 1: extract code from subject (CF sends "Your Cloudflare login token: NNNNNNN")
                                        subj = str(msg.get('subject', ''))
                                        subj_m = _re_otp.search(r'token[:\s]+(\d{5,9})', subj, _re_otp.I)
                                        if subj_m:
                                            otp_code = subj_m.group(1)
                                            log_step(f"OTP dari subject: {otp_code}")
                                        else:
                                            # Strategy 2: fetch body
                                            try:
                                                full = ammail_request(_ammail_base_url, _ammail_api_key, f"/messages/{urllib.parse.quote(mid)}")
                                                msg_body = full.get("message", full) if isinstance(full, dict) else {}
                                                body = str(msg_body.get('body','') or msg_body.get('html','') or msg_body.get('text','') or full.get('body','') or msg.get('snippet',''))
                                                ctx_m = _re_otp.search(r'(?:token|verify|code)[^\d]{0,30}(\d{5,9})', body, _re_otp.I)
                                                if not ctx_m:
                                                    for bm in _re_otp.finditer(r'(?m)^\s*(\d{5,9})\s*$', body):
                                                        ctx_m = bm; break
                                                if ctx_m:
                                                    try: otp_code = ctx_m.group(1)
                                                    except: otp_code = ctx_m.group(0)
                                                    if otp_code and len(set(otp_code)) > 1:
                                                        log_step(f"OTP dari body: {otp_code}")
                                            except Exception as _be:
                                                log_step(f"OTP body error: {_be}")
                                        if otp_code:
                                            break
                            except Exception as _otp_e:
                                log_step(f"OTP poll error: {_otp_e}")
                            if otp_code:
                                break


                        if otp_code:
                            # Dismiss consent overlay before looking for OTP input
                            try:
                                page.evaluate("""
                                    () => {
                                        const ot = document.querySelector('#onetrust-banner-sdk, #onetrust-consent-sdk');
                                        if (ot) ot.style.display = 'none';
                                    }
                                """)
                            except Exception: pass
                            time.sleep(1)
                            page.screenshot(path="/tmp/cf_otp_modal.png")

                            # Try dialog-specific selectors first, then broader
                            otp_input = None
                            for otp_sel in [
                                "[role='dialog'] input[type='text']",
                                "[aria-modal='true'] input[type='text']",
                                "input[autocomplete='one-time-code']",
                                "input[maxlength='6']",
                                "input[placeholder*='code' i]",
                                "input[placeholder*='verification' i]",
                                "input[id*='code' i]",
                                "input[name*='code' i]",
                                "input[name*='otp' i]",
                                # Broader: any visible text input except known cookie ones
                                "input[type='text']:not([name='vendor-search-handler']):not([id='vendor-search-handler'])",
                            ]:
                                try:
                                    el = page.locator(otp_sel).first
                                    if el.count() > 0 and el.is_visible(timeout=1500):
                                        # Sanity check: not the cookie search input
                                        el_id = el.get_attribute("id") or ""
                                        el_name = el.get_attribute("name") or ""
                                        if "vendor" in el_id or "vendor" in el_name:
                                            continue
                                        otp_input = el
                                        log_step(f"OTP input found: {otp_sel} (id={el_id})")
                                        break
                                except Exception:
                                    continue

                            # Last resort: JS — find first visible input in any modal/overlay
                            if not otp_input:
                                js_sel = page.evaluate("""
                                    () => {
                                        const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
                                        const v = inputs.find(i => {
                                            if (!i.offsetParent) return false;
                                            const id = (i.id||'') + (i.name||'');
                                            return !id.includes('vendor') && !id.includes('search');
                                        });
                                        return v ? (v.id || v.name || v.placeholder || 'found') : null;
                                    }
                                """)
                                log_step(f"JS OTP input scan: {js_sel}")
                                if js_sel:
                                    try:
                                        page.evaluate(f"""
                                            () => {{
                                                const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
                                                const v = inputs.find(i => {{
                                                    if (!i.offsetParent) return false;
                                                    const id = (i.id||'') + (i.name||'');
                                                    return !id.includes('vendor') && !id.includes('search');
                                                }});
                                                if (v) {{
                                                    v.focus();
                                                    v.value = '{otp_code}';
                                                    v.dispatchEvent(new Event('input', {{bubbles: true}}));
                                                    v.dispatchEvent(new Event('change', {{bubbles: true}}));
                                                }}
                                            }}
                                        """)
                                        log_step(f"OTP filled via JS inject")
                                    except Exception as jse:
                                        log_step(f"JS OTP fill error: {jse}")

                            if otp_input:
                                otp_input.fill(otp_code)
                                time.sleep(0.5)
                                page.screenshot(path="/tmp/cf_otp_filled.png")

                                # Solve Turnstile inside the Global API Key modal (if present)
                                # Log ALL frames to diagnose
                                all_frame_urls = [f.url[:80] for f in page.frames if f.url and f.url != 'about:blank']
                                log_step(f"GAK modal frames: {all_frame_urls}")

                                # Solve Turnstile in GAK modal
                                time.sleep(4)  # Let Turnstile iframe load after OTP filled
                                page.screenshot(path="/tmp/cf_gak_before_ts.png")
                                _ts_clicked = False

                                # Solve Turnstile in GAK modal
                                # Strategy: try auto-click first (works in non-headless Camoufox),
                                # then ALWAYS try 2Captcha inject as insurance (token injected
                                # before View is clicked, so CF accepts it either way).
                                _gak_ts_frame = next((f for f in page.frames if 'challenges.cloudflare.com' in (f.url or '')), None)
                                if _gak_ts_frame:
                                    log_step("GAK TS: Turnstile frame found")
                                    # Step 1: auto-click (non-headless Camoufox auto-solves)
                                    _ts_clicked = try_click_turnstile_checkbox(page)
                                    log_step(f"GAK TS auto-click result: {_ts_clicked}")
                                    time.sleep(5)  # wait for potential auto-solve
                                    # Step 2: always inject 2Captcha token as well (headless fallback)
                                    if args.captcha_key:
                                        log_step("GAK TS: injecting 2Captcha token...")
                                        try:
                                            _gak_sitekey = get_turnstile_sitekey(page)
                                            _gak_action = get_turnstile_action(page, default="managed")
                                            log_step(f"GAK TS action: {_gak_action}")
                                            _gak_ts_tok = solve_turnstile_2captcha(
                                                args.captcha_key,
                                                "https://dash.cloudflare.com/profile/api-tokens",
                                                _gak_sitekey,
                                                timeout=120,
                                                action=_gak_action,
                                            )
                                            if _gak_ts_tok:
                                                page.evaluate(f"""
                                                    () => {{
                                                        const tok = '{_gak_ts_tok}';
                                                        // Use React native setter trick — plain assignment bypasses React controlled inputs
                                                        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                                                        for (const name of ['cf-turnstile-response', 'cf_challenge_response']) {{
                                                            document.getElementsByName(name).forEach(el => {{
                                                                nativeSetter.call(el, tok);
                                                                el.dispatchEvent(new Event('input', {{bubbles: true}}));
                                                                el.dispatchEvent(new Event('change', {{bubbles: true}}));
                                                            }});
                                                        }}
                                                        // Also call Turnstile success callback if registered on widget
                                                        try {{
                                                            const widget = document.querySelector('[data-callback]');
                                                            const cbName = widget && widget.getAttribute('data-callback');
                                                            if (cbName && window[cbName]) window[cbName](tok);
                                                        }} catch(e) {{}}
                                                        // Try direct turnstile API
                                                        try {{
                                                            if (window.__cf_chl_opt && window.__cf_chl_opt.cFRq) {{
                                                                window.__cf_chl_opt.cFRq(tok);
                                                            }}
                                                        }} catch(e) {{}}
                                                    }}
                                                """)
                                                time.sleep(3)
                                                log_step(f"GAK TS: 2Captcha token injected ({_gak_ts_tok[:12]}...)")
                                                _ts_clicked = True
                                        except Exception as _2ce:
                                            log_step(f"GAK TS 2Captcha error: {_2ce}")
                                else:
                                    log_step("GAK TS: no Turnstile frame in modal (skip)")
                                    _ts_clicked = True  # no Turnstile needed

                                page.screenshot(path="/tmp/cf_gak_before_submit.png")

                                # Click View button INSIDE the modal (not the background View)
                                # Background page has [View] → modal has [View] — use .last to get modal's View
                                # Enumerate all visible View buttons for debugging
                                _view_cnt = page.locator("button:has-text('View')").count()
                                log_step(f"View buttons on page: {_view_cnt}")
                                _clicked_view = False
                                for btn_sel in [
                                    "[role='dialog'] button:has-text('View')",
                                    "[role='dialog'] button[type='submit']",
                                ]:
                                    try:
                                        b = page.locator(btn_sel)
                                        if b.count() > 0 and b.first.is_visible(timeout=1000):
                                            b.first.click()
                                            _clicked_view = True
                                            log_step(f"OTP submitted via dialog: {btn_sel}")
                                            break
                                    except Exception:
                                        pass

                                if not _clicked_view:
                                    # Use LAST View button (modal's View comes after background's View in DOM)
                                    try:
                                        _all_views = page.locator("button:has-text('View')")
                                        _cnt = _all_views.count()
                                        log_step(f"Trying last View ({_cnt} total)...")
                                        if _cnt > 0:
                                            _all_views.last.click()
                                            _clicked_view = True
                                            log_step("OTP submitted via: button.last View")
                                    except Exception as _le:
                                        log_step(f"Last View err: {_le}")

                                if not _clicked_view:
                                    try:
                                        page.locator("button[type='submit']").last.click()
                                        _clicked_view = True
                                        log_step("OTP submitted via: button[type=submit].last")
                                    except Exception:
                                        pass

                                if _clicked_view:
                                    time.sleep(5)
                                    page.screenshot(path="/tmp/cf_gak_after_submit.png")
                                    # Log modal state after submit — detect error or success
                                    try:
                                        _modal_txt = page.locator("[role='dialog']").inner_text(timeout=3000)
                                        log_step(f"Modal after View click: {_modal_txt[:300]}")
                                        # Check if error shown (invalid code, expired, etc.)
                                        _modal_lower = _modal_txt.lower()
                                        if any(w in _modal_lower for w in ["invalid", "incorrect", "expired", "error", "failed", "wrong"]):
                                            log_step("GAK modal shows error — OTP rejected by CF")
                                    except Exception:
                                        log_step("Modal closed after View click (good sign)")
                            else:
                                log_step("OTP input not found via any selector")

                except Exception as e:
                    log_step(f"OTP verify step: {e}")

                # CF shows a password confirmation dialog after OTP
                try:
                    pwd_input = page.locator("input[type='password']").first
                    if pwd_input.is_visible(timeout=3000):
                        pwd_input.evaluate("""
                            (el, pw) => {
                                const nativeSetter = Object.getOwnPropertyDescriptor(
                                    window.HTMLInputElement.prototype, 'value'
                                ).set;
                                nativeSetter.call(el, pw);
                                el.dispatchEvent(new Event('input', { bubbles: true }));
                                el.dispatchEvent(new Event('change', { bubbles: true }));
                            }
                        """, args.password)
                        time.sleep(0.5)
                        for btn_sel in ["button:has-text('Continue')", "button[type='submit']", "button:has-text('View')"]:
                            try:
                                b = page.locator(btn_sel).first
                                if b.count() > 0:
                                    b.click()
                                    time.sleep(2)
                                    log_step("Submitted password for Global API Key")
                                    break
                            except Exception:
                                continue
                except Exception:
                    pass

                # Extract Global API Key — poll every 2s for up to 60s
                # Key appears in input value after modal closes/changes
                global_key = None
                import re as _re2
                _key_regex = r'\b([a-f0-9]{36,45})\b'

                for _gk_poll in range(30):
                    if _gk_poll == 0:
                        # First poll — dump full page content to diagnose where key appears
                        try:
                            _body_dump = page.inner_text("body")
                            log_step(f"GAK body after modal close (first 500): {_body_dump[:500]}")
                            # Also dump all visible text values
                            _all_dom = page.evaluate("""
                                () => {
                                    const vals = [];
                                    document.querySelectorAll('*').forEach(el => {
                                        if (el.children.length === 0) {
                                            const t = (el.textContent || el.value || '').trim();
                                            if (t.length >= 30 && t.length <= 60 && /^[a-f0-9]+$/.test(t)) {
                                                vals.push(el.tagName + ': ' + t);
                                            }
                                        }
                                    });
                                    return vals.join(' | ');
                                }
                            """)
                            log_step(f"GAK hex strings in DOM: {_all_dom or 'none'}")
                            page.screenshot(path="/tmp/cf_gak_poll0.png")
                        except Exception as _dump_e:
                            log_step(f"GAK body dump error: {_dump_e}")
                        # Also log all CF API responses captured so far
                        if _intercepted_key:
                            log_step(f"GAK intercepted key at poll 0: {_intercepted_key[0][:12]}...")
                            global_key = _intercepted_key[0]
                            break
                    page.screenshot(path="/tmp/cf_globalkey_page.png")
                    # Check intercepted key each poll
                    if _intercepted_key:
                        global_key = _intercepted_key[0]
                        log_step(f"GAK from network intercept (poll {_gk_poll}): {global_key[:12]}...")
                        break
                    try:
                        # 1. Check ALL input + TEXTAREA values via evaluate
                        _all_vals = page.evaluate("""
                            () => {
                                const vals = [];
                                document.querySelectorAll('input, textarea').forEach(el => {
                                    if (el.value && el.value.length > 20) vals.push(el.value);
                                });
                                // Also check text content of specific elements
                                document.querySelectorAll('code, pre, [class*="key"], [class*="token"]').forEach(el => {
                                    const t = el.textContent || '';
                                    if (t.length > 20) vals.push(t.trim());
                                });
                                return vals.join('|||');
                            }
                        """)
                        if _all_vals:
                            # CF key formats: cfk_XXX (User API Token) OR 40-char hex (Global API Key)
                            _gk_m = _re2.search(r'(cfk_[a-zA-Z0-9]{30,}|[a-f0-9]{36,45})', _all_vals)
                            if _gk_m:
                                global_key = _gk_m.group(1)
                                log_step(f"GAK from input/textarea (poll {_gk_poll}): {global_key[:12]}...")
                                break

                        # 2. Check inner text
                        body_text = page.inner_text("body")
                        _gk_m2 = _re2.search(r'(cfk_[a-zA-Z0-9]{30,}|[a-f0-9]{36,45})', body_text)
                        if _gk_m2:
                            global_key = _gk_m2.group(1)
                            log_step(f"GAK from body text (poll {_gk_poll}): {global_key[:12]}...")
                            break

                        # 3. Textarea specifically
                        for _sel in ["textarea", "input[readonly]", "code"]:
                            try:
                                _el = page.locator(_sel).first
                                if _el.count() > 0:
                                    _v = (_el.input_value() if "input" in _sel or _sel=="textarea" else _el.text_content()) or ""
                                    _v = _v.strip()
                                    if len(_v) > 20 and ' ' not in _v:
                                        _gk_m3 = _re2.search(r'(cfk_[a-zA-Z0-9]{30,}|[a-f0-9]{36,45})', _v)
                                        if _gk_m3:
                                            global_key = _gk_m3.group(1)
                                            log_step(f"GAK from {_sel} (poll {_gk_poll}): {global_key[:12]}...")
                                            break
                            except Exception:
                                pass
                        if global_key:
                            break

                        log_step(f"GAK poll {_gk_poll}/30 — no key yet")
                    except Exception as _pe:
                        log_step(f"GAK poll error: {_pe}")

                    time.sleep(2)

                if not global_key:
                    log_step("Global API Key tidak ditemukan")
                    return None

                # Use Global API Key to create Workers AI token via CF API
                api_email_header = args.email  # email dari outer scope
                headers = {
                    "X-Auth-Email": api_email_header,
                    "X-Auth-Key": global_key,
                    "Content-Type": "application/json",
                }
                base_api = "https://api.cloudflare.com/client/v4"

                # Get Workers AI permission group ID
                r = _req.get(f"{base_api}/user/tokens/permission_groups", headers=headers, timeout=15)
                pg_data = r.json()
                workers_ai_id = None
                _wa_groups = pg_data.get('result', [])
                # Prefer exact "Workers AI Read" over "Workers AI Metadata Read"
                for pg in _wa_groups:
                    nm = pg.get('name', '')
                    if nm in ('Workers AI Read', 'Workers AI Write'):
                        workers_ai_id = pg['id']
                        log_step(f"Workers AI permission group id (exact): {nm} = {workers_ai_id}")
                        break
                if not workers_ai_id:
                    # fallback: any Workers AI group that is not Metadata
                    for pg in _wa_groups:
                        nm = pg.get('name', '')
                        if 'Workers AI' in nm and 'Metadata' not in nm:
                            workers_ai_id = pg['id']
                            log_step(f"Workers AI permission group id (fallback): {nm} = {workers_ai_id}")
                            break

                if not workers_ai_id:
                    log_step(f"Workers AI group not found. Available: {[p['name'] for p in pg_data.get('result', [])[:10]]}")
                    return None

                # Create the scoped token
                payload = {
                    "name": "9router-workers-ai",
                    "policies": [{
                        "effect": "allow",
                        "resources": {f"com.cloudflare.api.account.{account_id}": "*"},
                        "permission_groups": [{"id": workers_ai_id}]
                    }]
                }
                r2 = _req.post(f"{base_api}/user/tokens", json=payload, headers=headers, timeout=15)
                resp2 = r2.json()
                log_step(f"Token create via Global Key: {str(resp2)[:200]}")
                if resp2.get('success'):
                    return resp2['result'].get('value')
            except Exception as e:
                log_step(f"Global API Key approach failed: {e}")
            return None

        def create_token_via_session(page):
            """Use same-origin dashboard API proxy (most reliable method).
            CF dashboard at dash.cloudflare.com proxies /api/v4/... to the CF API
            with session cookies — no CORS issues, no OTP needed.
            """
            log_step("Mencoba buat token via same-origin API proxy...")
            try:
                # Verify session auth works first
                verify = page.evaluate("""
                    async () => {
                        try {
                            const r = await fetch('/api/v4/accounts?per_page=50', {
                                credentials: 'include',
                                headers: {'Accept': 'application/json'}
                            });
                            const d = await r.json();
                            return {status: r.status, ok: d.success, count: (d.result||[]).length};
                        } catch(e) { return {error: e.message}; }
                    }
                """)
                log_step(f"Same-origin auth check: {verify}")
                if not isinstance(verify, dict) or not verify.get('ok'):
                    log_step("Same-origin auth failed — not logged in")
                    return None

                # Step 1: get Workers AI permission group id
                pg_result = page.evaluate("""
                    async () => {
                        try {
                            const r = await fetch('/api/v4/user/tokens/permission_groups', {
                                credentials: 'include',
                                headers: {'Accept': 'application/json'}
                            });
                            const d = await r.json();
                            return {status: r.status, ok: d.success, groups: d.result || []};
                        } catch(e) { return {error: e.message}; }
                    }
                """)
                if not isinstance(pg_result, dict) or not pg_result.get('ok'):
                    log_step(f"permission_groups failed: {pg_result}")
                    return None

                groups = pg_result.get('groups', [])
                workers_ai_id = next(
                    (g["id"] for g in groups if g.get("name") in ("Workers AI Read", "Workers AI Write")), None
                )
                if not workers_ai_id:
                    workers_ai_id = next(
                        (g["id"] for g in groups if "Workers AI" in g.get("name", "") and "Metadata" not in g.get("name", "")), None
                    )
                if not workers_ai_id:
                    # Hardcoded fallback
                    workers_ai_id = "a92d2450e05d4e7bb7d0a64968f83d11"
                    log_step(f"Using hardcoded Workers AI perm group ID")
                log_step(f"Workers AI permission group id: {workers_ai_id}")

                # Step 2: create scoped API token via same-origin proxy
                token_result = page.evaluate("""
                    async (args) => {
                        try {
                            const payload = {
                                name: 'amrouter-workers-ai',
                                policies: [{
                                    effect: 'allow',
                                    resources: {[`com.cloudflare.api.account.${args.account_id}`]: '*'},
                                    permission_groups: [{id: args.perm_id}]
                                }]
                            };
                            const r = await fetch('/api/v4/user/tokens', {
                                method: 'POST',
                                credentials: 'include',
                                headers: {
                                    'Accept': 'application/json',
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify(payload)
                            });
                            const d = await r.json();
                            return {status: r.status, ok: d.success, value: d.result?.value || null, errors: d.errors || []};
                        } catch(e) { return {error: e.message}; }
                    }
                """, {"account_id": account_id, "perm_id": workers_ai_id})
                log_step(f"Token create result: {str(token_result)[:300]}")
                if isinstance(token_result, dict) and token_result.get('ok') and token_result.get('value'):
                    return token_result['value']
                log_step(f"Token create failed: {token_result.get('errors', token_result.get('error', 'unknown'))}")
            except Exception as e:
                log_step(f"Same-origin token exception: {e}")
            return None

        # Try session API first (fast, no OTP needed)
        try:
            workers_ai_token = create_token_via_session(page)
            if workers_ai_token:
                log_step(f"Token via session fetch: {workers_ai_token[:12]}...")
        except Exception as e:
            log_step(f"Session API token failed: {e}")

        # ── EARLY GAK ATTEMPT: Try Global API Key first if ammail available ─────
        # NOTE: Do NOT reset workers_ai_token if create_token_via_session already succeeded
        if not workers_ai_token:
            workers_ai_token = None  # only reset if still empty
        token_from_route = []  # always init — used later regardless of GAK success
        if ammail_ok:
            log_step("Mencoba GAK dulu (skip UI form yang sering gagal)...")
            try:
                workers_ai_token = create_token_via_global_key(page)
                if workers_ai_token:
                    log_step(f"Workers AI token via GAK (early): {workers_ai_token[:10]}...")
            except Exception as _egak_e:
                log_step(f"Early GAK error: {_egak_e}")

        # ── Strategy B: Browser UI — /profile/api-tokens/create (dropdown form)
        if not workers_ai_token:
            log_step("Trying browser UI token creation")

            # Setup route interception BEFORE navigating — capture CF's own token API call
            def _token_route_handler(route):
                req = route.request
                try:
                    resp = route.fetch()
                    if req.method == "POST" and "tokens" in req.url:
                        log_step(f"Route: POST {req.url} → {resp.status}")
                        if resp.status in (200, 201):
                            try:
                                d = resp.json()
                                if d.get("result", {}).get("value"):
                                    token_from_route.append(d["result"]["value"])
                                    log_step(f"TOKEN via route: {d['result']['value'][:10]}...")
                            except Exception:
                                pass
                    route.fulfill(response=resp)
                except Exception as route_err:
                    try: route.continue_()
                    except Exception: pass
            try:
                page.route("**/user/tokens**", _token_route_handler)
            except Exception as route_err:
                log_step(f"Route setup: {re}")

            for create_url in [
                "https://dash.cloudflare.com/profile/api-tokens/create",
                f"https://dash.cloudflare.com/{account_id}/api-tokens/create",
            ]:
                try:
                    page.goto(create_url, wait_until="domcontentloaded", timeout=25000)
                    wait_for_cf_clearance(page, timeout=15)
                    time.sleep(4)
                    current = page.url
                    log_step(f"Create token URL: {current}")
                    if "api-tokens/create" not in current:
                        log_step("Redirected away, try next...")
                        continue
                    break
                except Exception as e:
                    log_step(f"Nav error: {e}")
                    continue

        # Method 4: navigate to /accounts and parse
        if not account_id:
            try:
                page.goto("https://dash.cloudflare.com/?to=/:account/home", wait_until="domcontentloaded", timeout=15000)
                time.sleep(3)
                url_match = re.search(r"/(?:home/)?([a-f0-9]{32})(?:/|$)", page.url)
                if url_match:
                    account_id = url_match.group(1)
                    log_step(f"Account ID via redirect: {account_id[:8]}...")
            except Exception as e:
                log_step(f"account_id method4 error: {e}")

        # Method 4b: /memberships API (different endpoint, may work when /accounts fails)
        if not account_id:
            try:
                log_step("Method 4b: /memberships via page.request.fetch...")
                _mem_resp = page.request.fetch(
                    "https://api.cloudflare.com/client/v4/user/memberships?per_page=50",
                    method="GET",
                    headers={"Accept": "application/json"}
                )
                if _mem_resp.status == 200:
                    _mem_data = _mem_resp.json()
                    if _mem_data.get("success") and _mem_data.get("result"):
                        for _m in _mem_data["result"]:
                            _acct = _m.get("account", {}) or {}
                            _acct_id = _acct.get("id", "")
                            if _acct_id and len(_acct_id) == 32 and re.match(r'^[a-f0-9]{32}$', _acct_id):
                                account_id = _acct_id
                                log_step(f"Account ID via memberships (4b): {account_id[:8]}...")
                                break
            except Exception as e:
                log_step(f"Method 4b error: {e}")

        # Method 4c: page.evaluate fetch (native cookies, no CORS)
        if not account_id:
            try:
                log_step("Method 4c: page.evaluate fetch /accounts + /memberships...")
                _ev_id = page.evaluate("""
                    async () => {
                        const hex32 = /^[a-f0-9]{32}$/;
                        try {
                            const r = await fetch('https://api.cloudflare.com/client/v4/accounts?per_page=50', {
                                credentials: 'include',
                                headers: {'Accept': 'application/json'}
                            });
                            const d = await r.json();
                            if (d.success && d.result) {
                                for (const a of d.result) {
                                    if (a.id && hex32.test(a.id)) return a.id;
                                }
                            }
                        } catch(e) {}
                        try {
                            const r2 = await fetch('https://api.cloudflare.com/client/v4/user/memberships?per_page=50', {
                                credentials: 'include',
                                headers: {'Accept': 'application/json'}
                            });
                            const d2 = await r2.json();
                            if (d2.success && d2.result) {
                                for (const m of d2.result) {
                                    const id = (m.account && m.account.id) || '';
                                    if (id && hex32.test(id)) return id;
                                }
                            }
                        } catch(e) {}
                        return '';
                    }
                """)
                if _ev_id and len(_ev_id) == 32 and re.match(r'^[a-f0-9]{32}$', _ev_id):
                    account_id = _ev_id
                    log_step(f"Account ID via evaluate (4c): {account_id[:8]}...")
            except Exception as e:
                log_step(f"Method 4c error: {e}")

        if account_id:
            log_step(f"Account ID confirmed: {account_id[:8]}...")
        else:
            log_step("WARN: Account ID tidak ditemukan, lanjut tanpa account_id")

        # ── Step 9: Skip Global API Key (needs OTP) — buat Account API Token langsung ──
        global_key = None
        if not workers_ai_token:  # don't reset if GAK already succeeded!
            workers_ai_token = None

        if not account_id:
            die("Tidak bisa membuat API Token: account_id tidak ditemukan")

        # ── Step 10: Create Workers AI Token — proper CF UI flow ──────────────
        log_step("Membuat Workers AI API Token via browser...")
        try:
            # Helper: dismiss any OneTrust / GDPR cookie consent dialogs
            def dismiss_consent_dialogs(page):
                """Dismiss OneTrust, cookie consent, GDPR popups that block the page."""
                dismissed = False
                for sel in [
                    "button#onetrust-accept-btn-handler",
                    "button#accept-recommended-btn-handler",
                    "#onetrust-accept-btn-handler",
                    "button:has-text('Accept all')",
                    "button:has-text('Accept All')",
                    "button:has-text('Accept All Cookies')",
                    "button:has-text('I Accept')",
                    "button:has-text('Accept')",
                    "button:has-text('Agree')",
                    "button:has-text('Confirm')",
                    "button:has-text('Save Preferences')",
                    "[id*='accept'][id*='cookie']",
                    ".ot-sdk-btn-floating",
                    "[class*='onetrust'] button[class*='accept']",
                    "[class*='onetrust'] button[class*='confirm']",
                ]:
                    try:
                        el = page.locator(sel).first
                        if el.count() > 0 and el.is_visible(timeout=800):
                            el.click()
                            log_step(f"Dismissed consent via: {sel}")
                            time.sleep(0.5)
                            dismissed = True
                            break
                    except Exception:
                        continue
                # Also try JS dismiss as backup (covers any modal/overlay)
                if not dismissed:
                    try:
                        result = page.evaluate("""
                            () => {
                                // Try standard OneTrust dismiss
                                const btns = Array.from(document.querySelectorAll('button'));
                                for (const btn of btns) {
                                    const txt = btn.textContent.trim().toLowerCase();
                                    if (txt === 'accept all' || txt === 'accept all cookies' ||
                                        txt === 'i accept' || txt === 'save preferences' ||
                                        btn.id === 'onetrust-accept-btn-handler') {
                                        btn.click();
                                        return 'JS dismissed: ' + btn.textContent.trim();
                                    }
                                }
                                // Hide OneTrust overlay if present
                                const ot = document.querySelector('#onetrust-consent-sdk, .onetrust-pc-dark-filter');
                                if (ot) { ot.style.display = 'none'; return 'hidden onetrust overlay'; }
                                return 'no consent dialog found';
                            }
                        """)
                        if "dismissed" in result or "hidden" in result:
                            log_step(f"Consent JS: {result}")
                    except Exception:
                        pass

            # 1. Navigate to profile/api-tokens (not account-specific)
            page.goto("https://dash.cloudflare.com/profile/api-tokens", wait_until="domcontentloaded", timeout=25000)
            wait_for_cf_clearance(page, timeout=15)
            time.sleep(3)
            dismiss_consent_dialogs(page)
            log_step(f"API Tokens page: {page.url}")
            page.screenshot(path="/tmp/cf_tokens_page.png")

            # 2. Click "Create Token" button → wait for template page to render
            for btn_sel in ["button:has-text('Create Token')", "a:has-text('Create Token')"]:
                try:
                    b = page.locator(btn_sel).first
                    if b.count() > 0 and b.is_visible(timeout=3000):
                        b.click()
                        log_step(f"Clicked Create Token via: {btn_sel}")
                        break
                except Exception:
                    continue

            # Wait for template page content (React routing — URL stays same)
            # OneTrust GDPR consent dialog can appear AFTER navigating to template page
            # — retry dismiss up to 3x while waiting for template buttons
            workers_ai_template_used = False
            template_page_ready = False
            for _wait_attempt in range(3):
                try:
                    page.wait_for_selector("button:has-text('Use template')", timeout=5000)
                    template_page_ready = True
                    log_step(f"Template page ready (attempt {_wait_attempt+1})")
                    break
                except Exception:
                    log_step(f"Template wait timeout attempt {_wait_attempt+1} — dismissing consent")
                    dismiss_consent_dialogs(page)
                    time.sleep(2)

            dismiss_consent_dialogs(page)
            page.screenshot(path="/tmp/cf_create_token_page.png")
            log_step(f"After Create Token click: {page.url}")

            try:
                # Find the "Workers AI" template row and click its "Use template" button
                # Structure: <tr> or <div> containing "Workers AI" text + "Use template" button
                wa_row = page.locator("tr:has-text('Workers AI'), li:has-text('Workers AI'), [class*='row']:has-text('Workers AI')").first
                if wa_row.count() > 0 and wa_row.is_visible(timeout=3000):
                    use_btn = wa_row.locator("button:has-text('Use template'), a:has-text('Use template')")
                    if use_btn.count() > 0 and use_btn.is_visible(timeout=2000):
                        use_btn.click()
                        time.sleep(3)
                        log_step("Workers AI template clicked via row")
                        workers_ai_template_used = True
            except Exception as e:
                log_step(f"Template row approach: {e}")

            # Fallback: find "Use template" button next to "Workers AI" text using JS
            if not workers_ai_template_used:
                try:
                    # Get all "Use template" buttons and find the one near "Workers AI" text
                    use_btns = page.locator("button:has-text('Use template')").all()
                    log_step(f"Found {len(use_btns)} Use template buttons")
                    # Workers AI is typically the 5th template (index 4)
                    # Find by evaluating each button's nearby text
                    result = page.evaluate("""
                        () => {
                            const btns = Array.from(document.querySelectorAll('button'));
                            const useTemplateBtns = btns.filter(b => b.textContent.trim() === 'Use template');
                            for (const btn of useTemplateBtns) {
                                // Check if the parent row/section contains "Workers AI"
                                let el = btn.parentElement;
                                for (let i = 0; i < 5; i++) {
                                    if (el && el.textContent.includes('Workers AI') && !el.textContent.includes('Cloudflare Workers')) {
                                        btn.click();
                                        return 'clicked Workers AI template: ' + el.textContent.substring(0, 50);
                                    }
                                    el = el ? el.parentElement : null;
                                }
                            }
                            return 'Workers AI template button not found';
                        }
                    """)
                    log_step(f"JS template click: {result}")
                    if "clicked" in result:
                        workers_ai_template_used = True
                        time.sleep(3)
                except Exception as e:
                    log_step(f"JS template fallback: {e}")

            if workers_ai_template_used:
                # Workers AI template pre-fills the form — just rename the token and submit
                log_step(f"Template form URL: {page.url}")
                page.screenshot(path="/tmp/cf_template_form.png")

                # Rename token from default to "9router-workers-ai"
                try:
                    for name_sel in ["input[name*='name' i]", "input[placeholder*='name' i]", "input[type='text']:first-of-type"]:
                        try:
                            el = page.locator(name_sel).first
                            if el.count() > 0 and el.is_visible(timeout=2000):
                                el.click(click_count=3)
                                el.fill("9router-workers-ai")
                                log_step("Token name renamed: 9router-workers-ai")
                                break
                        except Exception:
                            continue
                except Exception as e:
                    log_step(f"Rename token: {e}")

                workers_ai_permission_set = True  # template already has Workers AI + Read
            else:
                # Fallback to custom token form
                log_step("Template not found, trying custom token form")
                # 3. Click "Get started" for Custom Token
                for sel in ["button:has-text('Get started')", "a:has-text('Get started')"]:
                    try:
                        b = page.locator(sel).first
                        if b.count() > 0 and b.is_visible(timeout=3000):
                            b.click()
                            time.sleep(2)
                            log_step(f"Clicked Get started via: {sel}")
                            break
                    except Exception:
                        continue

                time.sleep(2)
                page.screenshot(path="/tmp/cf_custom_token_form.png")

                # 4. Fill Token name
                for name_sel in ["input[placeholder*='name' i]", "input[name*='name' i]", "input[aria-label*='name' i]", "input:first-of-type"]:
                    try:
                        el = page.locator(name_sel).first
                        if el.count() > 0 and el.is_visible(timeout=2000):
                            el.click()
                            el.fill("9router-workers-ai")
                            time.sleep(0.5)
                            log_step("Token name filled: 9router-workers-ai")
                            break
                    except Exception:
                        continue

                # 5. Select Workers AI permission
                try:
                    page.wait_for_selector("input[aria-autocomplete]", timeout=8000)
                    time.sleep(1)
                    log_step("React form loaded, searching dropdowns")
                except Exception as e:
                    log_step(f"Wait for form timeout: {e}")
                    time.sleep(2)

                workers_ai_permission_set = False

                # Find all select-like elements
                try:
                    perm_dropdowns = page.locator("select, [role='combobox'], [role='listbox']").all()
                    log_step(f"Found {len(perm_dropdowns)} dropdowns")
                    for sel in ["input[aria-autocomplete]", "[class*='select'] input", "[placeholder*='Select' i]"]:
                        try:
                            els = page.locator(sel).all()
                            for el in els:
                                if el.is_visible():
                                    el.click()
                                    time.sleep(0.5)
                                    el.fill("Workers AI")
                                    time.sleep(1)
                                    wa_opt = page.locator("text=Workers AI").first
                                    if wa_opt.count() > 0 and wa_opt.is_visible(timeout=2000):
                                        wa_opt.click()
                                        time.sleep(0.5)
                                        log_step(f"Workers AI selected via: {sel}")
                                        workers_ai_permission_set = True
                                        break
                            if workers_ai_permission_set:
                                break
                        except Exception:
                            continue
                except Exception as e:
                    log_step(f"Workers AI dropdown: {e}")

            # Strategy B: use keyboard Tab to navigate to permission select, type Workers AI
            if not workers_ai_permission_set:
                try:
                    # Find native <select> elements
                    selects = page.locator("select").all()
                    log_step(f"Native selects: {len(selects)}")
                    for i, sel_el in enumerate(selects):
                        try:
                            opts = sel_el.evaluate("el => Array.from(el.options).map(o => o.text)")
                            log_step(f"Select {i} options: {opts[:5]}")
                            if any('Workers AI' in o for o in opts):
                                sel_el.select_option(label="Workers AI")
                                time.sleep(0.5)
                                log_step(f"Workers AI selected via native select {i}")
                                workers_ai_permission_set = True
                                break
                        except Exception:
                            continue
                except Exception as e:
                    log_step(f"Strategy B selects: {e}")

            # Strategy C: JS evaluate — find the select with Workers AI and set it
            if not workers_ai_permission_set:
                try:
                    result = page.evaluate("""
                        () => {
                            // Find all select elements
                            const selects = Array.from(document.querySelectorAll('select'));
                            for (const sel of selects) {
                                const opts = Array.from(sel.options);
                                const waOpt = opts.find(o => o.text.trim() === 'Workers AI');
                                if (waOpt) {
                                    sel.value = waOpt.value;
                                    sel.dispatchEvent(new Event('change', {bubbles: true}));
                                    return 'Workers AI set on select: ' + (sel.name || sel.id || 'unnamed');
                                }
                            }
                            return 'Workers AI option not found in any select';
                        }
                    """)
                    log_step(f"JS select: {result}")
                    if 'Workers AI set' in str(result):
                        workers_ai_permission_set = True
                        time.sleep(0.5)
                except Exception as e:
                    log_step(f"Strategy C JS: {e}")

            page.screenshot(path="/tmp/cf_after_perm_select.png")
            log_step(f"After permission selection (set={workers_ai_permission_set})")
            time.sleep(1)

            # 5b. Select "Edit" — ONLY for custom form, NOT template
            # Template already has Workers AI:Read; adding again = duplicate permission = validation fail
            read_set = workers_ai_template_used  # template = already done
            if workers_ai_template_used:
                log_step("Template used — skip Read/Edit dropdown (Workers AI:Read already set)")
            else:
                time.sleep(0.5)

                # Strategy A: JS — find all React-Select containers, click the one showing "Select..."
                try:
                    result = page.evaluate("""
                        () => {
                            // Find all elements with placeholder "Select..."
                            const all = Array.from(document.querySelectorAll('*'));
                            for (const el of all) {
                                if (el.children.length === 0 && el.textContent.trim() === 'Select...') {
                                    el.click();
                                    return 'clicked placeholder: ' + el.tagName + ' ' + el.className;
                                }
                            }
                            return 'placeholder not found';
                        }
                    """)
                    log_step(f"JS click Select...: {result}")
                    time.sleep(1)
                    # Now look for Edit or Read option in dropdown
                    for perm_label in ["Edit", "Read"]:
                        for read_sel in [f"text='{perm_label}'", f"[role='option']:has-text('{perm_label}')", f"li:has-text('{perm_label}')"]:
                            try:
                                r = page.locator(read_sel).first
                                if r.count() > 0 and r.is_visible(timeout=1500):
                                    r.click()
                                    time.sleep(0.5)
                                    log_step(f"{perm_label} selected via: {read_sel}")
                                    read_set = True
                                    break
                            except Exception:
                                continue
                        if read_set:
                            break
                except Exception as e:
                    log_step(f"Strategy A JS click: {e}")

                # Strategy B: bounding box — the Select... is to the right of Workers AI row
                if not read_set:
                    try:
                        # Find the Workers AI input in the permissions row
                        wa_inputs = page.locator("input[aria-autocomplete]").all()
                        for wa_inp in wa_inputs:
                            try:
                                if "Workers AI" in (wa_inp.input_value() or ""):
                                    wa_box = wa_inp.bounding_box()
                                    if wa_box:
                                        # The Select... dropdown is to the right
                                        select_x = wa_box["x"] + wa_box["width"] + 200
                                        select_y = wa_box["y"] + wa_box["height"] / 2
                                        page.mouse.click(select_x, select_y)
                                        time.sleep(1)
                                        log_step(f"Positional click Select... at ({select_x:.0f},{select_y:.0f})")
                                        page.screenshot(path="/tmp/cf_after_select_click.png")
                                        for perm_label in ["Edit", "Read"]:
                                            for read_sel in [f"text='{perm_label}'", f"[role='option']:has-text('{perm_label}')"]:
                                                try:
                                                    r = page.locator(read_sel).first
                                                    if r.count() > 0 and r.is_visible(timeout=1500):
                                                        r.click()
                                                        time.sleep(0.5)
                                                        log_step(f"{perm_label} selected (positional)")
                                                        read_set = True
                                                        break
                                                except Exception:
                                                    continue
                                            if read_set:
                                                break
                                        break
                            except Exception:
                                continue
                    except Exception as e:
                        log_step(f"Strategy B positional: {e}")

                # Strategy C: keyboard Tab navigation
                if not read_set:
                    try:
                        page.keyboard.press("Tab")
                        time.sleep(0.5)
                        page.keyboard.press("Tab")
                        time.sleep(0.5)
                        page.keyboard.press("Enter")
                        time.sleep(0.8)
                        # Try arrow down to navigate options
                        page.keyboard.press("ArrowDown")
                        time.sleep(0.3)
                        page.keyboard.press("Enter")
                        time.sleep(0.5)
                        log_step("Read/Edit via Tab+Enter keyboard")
                        read_set = True
                    except Exception as e:
                        log_step(f"Strategy C keyboard: {e}")

            log_step(f"Read access level set: {read_set}")
            page.screenshot(path="/tmp/cf_after_read_select.png")

            # Log all form inputs/selects for debugging
            try:
                form_state = page.evaluate("""
                    () => {
                        const inputs = Array.from(document.querySelectorAll('input, select, textarea'));
                        return inputs.map(el => ({
                            tag: el.tagName, type: el.type, name: el.name,
                            value: el.value, placeholder: el.placeholder
                        })).filter(el => el.value || el.placeholder);
                    }
                """)
                log_step(f"Form state: {str(form_state)[:500]}")
            except Exception:
                pass

            # 6. Fill Account Resources then click "Continue to summary"
            time.sleep(1)
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            time.sleep(1)

            # Account Resources — [Include ▼][Select... ▼] — REQUIRED (red error if empty)
            # "Select..." is a React Select — click .react-select__control or .react-select__dropdown-indicator
            try:
                ar_opened = page.evaluate("""
                    () => {
                        // Find react-select__control that has "Select..." placeholder (= Account Resources)
                        const ctrls = Array.from(document.querySelectorAll('[class*="react-select__control"]'));
                        for (const ctrl of ctrls) {
                            const ph = ctrl.querySelector('[class*="react-select__placeholder"]');
                            if (ph && ph.textContent.trim() === 'Select...') {
                                // Click the dropdown indicator (the ▼ arrow)
                                const ind = ctrl.querySelector('[class*="react-select__dropdown-indicator"]');
                                if (ind) { ind.click(); return 'indicator clicked'; }
                                ctrl.click();
                                return 'control clicked';
                            }
                        }
                        return 'no Select... control found';
                    }
                """)
                log_step(f"Account Resources React Select: {ar_opened}")

                if "clicked" in ar_opened:
                    # Take screenshot to see dropdown state
                    page.screenshot(path="/tmp/cf_ar_dropdown.png")
                    time.sleep(2)  # Wait for async option load

                    # Step 1: Check options WITHOUT typing (initial load)
                    opts_initial = page.evaluate("""
                        () => {
                            const opts = Array.from(document.querySelectorAll('[class*="react-select__option"], [class*="option"]'));
                            const menu = document.querySelector('[class*="react-select__menu"]');
                            const menuHtml = menu ? menu.innerHTML.substring(0, 300) : 'NO MENU';
                            return {
                                opts: opts.filter(o => o.offsetParent !== null).map(o => o.textContent.trim()),
                                menuHtml: menuHtml
                            };
                        }
                    """)
                    log_step(f"AR initial options: {opts_initial.get('opts', [])} | menu: {opts_initial.get('menuHtml','')[:100]}")

                    # Take screenshot to see what menu looks like
                    page.screenshot(path="/tmp/cf_ar_menu.png")

                    ar_selected = False
                    if opts_initial.get('opts'):
                        first = page.locator("[class*='react-select__option']").first
                        if first.count() > 0 and first.is_visible(timeout=1000):
                            txt = first.text_content() or "?"
                            first.click()
                            time.sleep(0.5)
                            log_step(f"Account Resources selected (initial): {txt[:60]}")
                            ar_selected = True

                    # Step 2: If still empty, try typing "all"
                    if not ar_selected:
                        page.keyboard.type("all", delay=80)
                        time.sleep(2)
                        opts_all = page.evaluate("""() => {
                            const opts = Array.from(document.querySelectorAll('[class*="react-select__option"]'));
                            return opts.filter(o => o.offsetParent !== null).map(o => o.textContent.trim());
                        }""")
                        log_step(f"AR after 'all': {opts_all}")
                        if opts_all:
                            page.locator("[class*='react-select__option']").first.click()
                            ar_selected = True
                            log_step(f"AR selected after 'all': {opts_all[0][:50]}")

                    # Step 3: Try account_id prefix
                    if not ar_selected:
                        page.keyboard.press("Control+a")
                        page.keyboard.type(account_id[:8], delay=80)
                        time.sleep(2)
                        opts_id = page.evaluate("""() => {
                            const opts = Array.from(document.querySelectorAll('[class*="react-select__option"]'));
                            return opts.filter(o => o.offsetParent !== null).map(o => o.textContent.trim());
                        }""")
                        log_step(f"AR after acct_id: {opts_id}")
                        if opts_id:
                            page.locator("[class*='react-select__option']").first.click()
                            ar_selected = True
                            log_step(f"AR selected after acct_id: {opts_id[0][:50]}")

                    if not ar_selected:
                        page.keyboard.press("Escape")
                        log_step(f"Account Resources: no options found — trying React inject")

                        # React fiber inject: walk up fiber tree to find onChange handler
                        inject_result = page.evaluate(f"""
                            () => {{
                                const ctrls = Array.from(document.querySelectorAll('[class*="react-select__control"]'));
                                const arCtrl = ctrls.find(c => {{
                                    const ph = c.querySelector('[class*="react-select__placeholder"]');
                                    return ph && ph.textContent.trim() === 'Select...';
                                }});
                                if (!arCtrl) return 'No Select... control';
                                const input = arCtrl.querySelector('input');
                                if (!input) return 'No input';
                                const fk = Object.keys(input).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance') || k.startsWith('__reactProps'));
                                if (!fk) {{
                                    const allKeys = Object.keys(input).filter(k=>k.startsWith('__')).join(',');
                                    return 'No fiber. React keys: ' + allKeys;
                                }}
                                let fiber = input[fk];
                                for (let i = 0; i < 25; i++) {{
                                    if (!fiber || !fiber.return) break;
                                    fiber = fiber.return;
                                    const p = fiber.memoizedProps;
                                    if (p && typeof p.onChange === 'function') {{
                                        try {{
                                            p.onChange(
                                                {{value: '{account_id}', label: 'My Account'}},
                                                {{action: 'select-option'}}
                                            );
                                            return 'React onChange called OK';
                                        }} catch(e) {{ return 'onChange error: ' + e.message; }}
                                    }}
                                }}
                                return 'onChange not found';
                            }}
                        """)
                        log_step(f"Account Resources React inject: {inject_result}")
                        time.sleep(1)

            except Exception as e:
                log_step(f"Account Resources error: {e}")

            page.screenshot(path="/tmp/cf_before_continue.png")

            def _is_summary_page():
                """CF uses React SPA — URL never changes. Detect summary by content.
                IMPORTANT: use 'token will affect' only — NOT 'summary' which matches
                the 'Continue to summary' BUTTON TEXT on the form page (false positive)."""
                try:
                    txt = page.inner_text("body")
                    # "token will affect" only appears on the actual summary page
                    # "Workers AI API token summary" also works
                    return ("token will affect" in txt or "API token summary" in txt)
                except Exception:
                    return False

            continue_clicked = False  # always try clicking Continue first
            if not continue_clicked:
                for sel in [
                    "button:has-text('Continue to summary')",
                    "input[value*='Continue']",
                    "button:has-text('Continue')",
                    "button:has-text('Review')",
                    "button[type='submit']",
                ]:
                    try:
                        loc = page.locator(sel).first
                        if loc.count() > 0 and loc.is_visible(timeout=3000):
                            loc.scroll_into_view_if_needed()
                            time.sleep(0.3)
                            bbox = loc.bounding_box()
                            if bbox:
                                page.mouse.move(bbox['x'] + bbox['width']/2, bbox['y'] + bbox['height']/2)
                                time.sleep(0.2)
                                page.mouse.click(bbox['x'] + bbox['width']/2, bbox['y'] + bbox['height']/2)
                                log_step(f"Mouse.click Continue via: {sel}")
                            else:
                                loc.click()
                            time.sleep(3)
                            page.screenshot(path="/tmp/cf_after_continue.png")
                            if _is_summary_page():
                                log_step("Summary page detected (React routing)")
                                continue_clicked = True
                                break
                            log_step(f"'{sel}' clicked, not on summary yet")
                            try:
                                err = page.evaluate("Array.from(document.querySelectorAll('[class*=error],[class*=alert],[role=alert]')).map(e=>e.innerText).join(' ')")
                                if err:
                                    log_step(f"Form error: {err[:200]}")
                            except Exception:
                                pass
                    except Exception as e:
                        log_step(f"Continue '{sel}' failed: {e}")
                        continue

            log_step(f"Continue to summary: {continue_clicked}")

            # 7a. If "Continue to summary" failed, try CF API via browser session cookies
            # This bypasses ALL form UI issues — uses browser session (cf_clearance + cookies)
            if not continue_clicked:
                log_step("Continue failed — trying CF API via browser session (page.evaluate fetch)")
                try:
                    # The permission group IDs are hardcoded from CF's workers-ai template:
                    # a92d2450e05d4e7bb7d0a64968f83d11 = Workers AI Read
                    # bacc64e0f6c34fc0883a1223f938a104 = Workers AI Edit  
                    # account_id is available from earlier login step
                    # page.request.fetch uses browser cookies (avoids CORS — runs outside browser JS)
                    import json as _json
                    api_payload = _json.dumps({
                        "name": "Workers AI",
                        "policies": [{
                            "effect": "allow",
                            "resources": {
                                f"com.cloudflare.api.account.{account_id}": "*"
                            },
                            "permission_groups": [
                                {"id": "a92d2450e05d4e7bb7d0a64968f83d11"},
                                {"id": "bacc64e0f6c34fc0883a1223f938a104"}
                            ]
                        }]
                    })
                    api_resp = page.request.fetch(
                        "https://api.cloudflare.com/client/v4/user/tokens",
                        method="POST",
                        headers={"Content-Type": "application/json", "Accept": "application/json"},
                        data=api_payload
                    )
                    log_step(f"CF API /user/tokens status: {api_resp.status}")
                    if api_resp.status in (200, 201):
                        api_data = api_resp.json()
                        if api_data.get("success") and api_data.get("result", {}).get("value"):
                            api_token = api_data["result"]["value"]
                            log_step(f"CF API token created: {api_token[:10]}...")
                            output_result({"status": "ok", "email": args.email, "api_key": api_token, "account_id": account_id})
                            sys.exit(0)
                        else:
                            log_step(f"CF API token create failed: {api_data.get('errors', 'unknown')}")
                    else:
                        body_text = api_resp.text()[:300]
                        log_step(f"CF API HTTP {api_resp.status}: {body_text}")
                except Exception as e:
                    log_step(f"CF API fallback error: {e}")

            # 7. On summary page, click "Create Token"
            time.sleep(2)
            page.screenshot(path="/tmp/cf_summary_page.png")
            for sel in ["button:has-text('Create Token')", "input[value*='Create Token']", "button[type='submit']"]:
                try:
                    b = page.locator(sel).first
                    if b.count() > 0 and b.is_visible(timeout=5000):
                        b.scroll_into_view_if_needed()
                        time.sleep(0.3)
                        b.click()
                        time.sleep(5)
                        log_step(f"Create Token clicked via: {sel}")
                        break
                except Exception:
                    continue

            # 8. Extract token from result page
            page.screenshot(path="/tmp/cf_token_result.png")
            log_step("Screenshot token result saved")

            # CF token result page shows token in a dashed-border div as plain text
            # Also check <code>, <input readonly>, etc.
            # Try cfut_ pattern directly first from page body (most reliable)
            try:
                body_text = page.inner_text("body")
                import re as _re_tok
                cfut_m = _re_tok.search(r'\b(cfut_[A-Za-z0-9_\-]{30,})\b', body_text)
                if cfut_m and not workers_ai_token:
                    workers_ai_token = cfut_m.group(1)
                    log_step(f"Token dari body regex: {workers_ai_token[:12]}...")
            except Exception as _e:
                log_step(f"Body token regex: {_e}")

            # Fallback: try specific selectors
            if not workers_ai_token:
                for sel in ["code", "input[readonly]", "input[type='text'][readonly]",
                            "[data-testid='token-value']", ".cf-input-code",
                            "input[class*='token']", "input[class*='code']", "input[class*='api']"]:
                    try:
                        el = page.locator(sel).first
                        if el.is_visible(timeout=2000):
                            val = el.input_value() if "input" in sel else el.text_content()
                            val = (val or "").strip()
                            if val and len(val) > 10 and ' ' not in val:
                                workers_ai_token = val
                                log_step(f"Token dari selector {sel}: {val[:12]}...")
                                break
                    except Exception:
                        continue

            # Fallback: extract token-like string from body (cfp_ or similar)
            if not workers_ai_token:
                try:
                    body = page.inner_text("body")
                    import re as _re
                    # CF tokens start with cfut_ or similar
                    for pattern in [r'\b(cfut_[A-Za-z0-9_\-]{30,})\b', r'\b([A-Za-z0-9_\-]{40,})\b']:
                        tok_match = _re.search(pattern, body)
                        if tok_match:
                            workers_ai_token = tok_match.group(1)
                            log_step(f"Token dari body: {workers_ai_token[:12]}...")
                            break
                except Exception:
                    pass

        except Exception as e:
            log_step(f"Token creation error: {e}")
            try:
                page.screenshot(path="/tmp/cf_create_token_err.png")
            except Exception:
                pass


        # Final API key to save
        if not workers_ai_token and token_from_route:
            workers_ai_token = token_from_route[0]
            log_step(f"Token from route: {workers_ai_token[:10]}...")

        # Strategy A: Global API Key from dashboard UI (last resort — needs OTP from email)
        if not workers_ai_token and ammail_ok:
            log_step("Fallback: mencoba Global API Key dari dashboard UI...")
            try:
                global_key_token = create_token_via_global_key(page)
                if global_key_token:
                    workers_ai_token = global_key_token
                    log_step(f"Workers AI token via Global Key: {workers_ai_token[:10]}...")
            except Exception as gke:
                log_step(f"Global API Key fallback error: {gke}")

        # ── Strategy C: Dashboard same-origin API proxy ──────────────────────
        # CF dashboard proxies /api/v4/... to api.cloudflare.com with session cookies
        # This is SAME-ORIGIN so no CORS issues — the most reliable method
        if not workers_ai_token and account_id:
            log_step("Strategy C: Dashboard same-origin API proxy...")
            try:
                # First verify session auth works
                verify_result = page.evaluate("""
                    async () => {
                        try {
                            const r = await fetch('/api/v4/accounts?per_page=50', {
                                credentials: 'include',
                                headers: {'Accept': 'application/json'}
                            });
                            const d = await r.json();
                            return {status: r.status, ok: d.success, count: (d.result||[]).length,
                                    first_id: (d.result||[])[0]?.id || ''};
                        } catch(e) { return {error: e.message}; }
                    }
                """)
                log_step(f"Strategy C verify: {verify_result}")

                if isinstance(verify_result, dict) and verify_result.get('ok'):
                    # Get permission groups
                    pg_result = page.evaluate("""
                        async () => {
                            try {
                                const r = await fetch('/api/v4/user/tokens/permission_groups', {
                                    credentials: 'include',
                                    headers: {'Accept': 'application/json'}
                                });
                                const d = await r.json();
                                return {status: r.status, ok: d.success, groups: d.result || []};
                            } catch(e) { return {error: e.message}; }
                        }
                    """)
                    log_step(f"Strategy C perm groups: status={pg_result.get('status') if isinstance(pg_result, dict) else 'err'}")

                    wa_read_id = None
                    wa_write_id = None
                    if isinstance(pg_result, dict) and pg_result.get('ok'):
                        for g in pg_result.get('groups', []):
                            gname = g.get('name', '')
                            if gname == 'Workers AI Read':
                                wa_read_id = g['id']
                            elif gname == 'Workers AI Write':
                                wa_write_id = g['id']
                        if not wa_read_id:
                            wa_read_id = next(
                                (g['id'] for g in pg_result.get('groups', [])
                                 if 'Workers AI' in g.get('name', '') and 'Metadata' not in g.get('name', '')),
                                None
                            )

                    if not wa_read_id:
                        wa_read_id = "a92d2450e05d4e7bb7d0a64968f83d11"
                        wa_write_id = "bacc64e0f6c34fc0883a1223f938a104"
                        log_step(f"Strategy C: Using hardcoded perm group IDs")

                    if wa_read_id:
                        log_step(f"Strategy C: Workers AI perm group: {wa_read_id}")
                        # Create token via same-origin proxy
                        perm_groups = [{"id": wa_read_id}]
                        if wa_write_id:
                            perm_groups.append({"id": wa_write_id})

                        token_result = page.evaluate("""
                            async (args) => {
                                try {
                                    const payload = {
                                        name: 'amrouter-workers-ai',
                                        policies: [{
                                            effect: 'allow',
                                            resources: {[`com.cloudflare.api.account.${args.account_id}`]: '*'},
                                            permission_groups: args.perm_groups
                                        }]
                                    };
                                    const r = await fetch('/api/v4/user/tokens', {
                                        method: 'POST',
                                        credentials: 'include',
                                        headers: {
                                            'Accept': 'application/json',
                                            'Content-Type': 'application/json'
                                        },
                                        body: JSON.stringify(payload)
                                    });
                                    const d = await r.json();
                                    return {
                                        status: r.status,
                                        ok: d.success,
                                        value: d.result?.value || null,
                                        errors: d.errors || []
                                    };
                                } catch(e) { return {error: e.message}; }
                            }
                        """, {"account_id": account_id, "perm_groups": perm_groups})
                        log_step(f"Strategy C token result: status={token_result.get('status') if isinstance(token_result, dict) else 'err'}")

                        if isinstance(token_result, dict) and token_result.get('ok') and token_result.get('value'):
                            workers_ai_token = token_result['value']
                            log_step(f"Strategy C token created: {workers_ai_token[:15]}...")
                        elif isinstance(token_result, dict):
                            log_step(f"Strategy C token failed: {token_result.get('errors', token_result.get('error', 'unknown'))}")
                else:
                    log_step(f"Strategy C: Session auth failed: {verify_result}")
            except Exception as sce:
                log_step(f"Strategy C error: {sce}")

        # ── Strategy D: CF API direct with session cookies (Python requests) ──────
        # Bypasses browser UI entirely — uses browser session cookies to auth with CF API
        if not workers_ai_token and account_id:
            log_step("Strategy D: CF API direct via session cookies (Python requests)...")
            try:
                import requests as _req_d
                cookies = page.context.cookies()
                cookie_str = "; ".join(f"{c['name']}={c['value']}" for c in cookies)
                if cookie_str:
                    # Step 1: Get Workers AI permission group IDs
                    pg_resp = _req_d.get(
                        "https://api.cloudflare.com/client/v4/user/tokens/permission_groups",
                        headers={
                            "Cookie": cookie_str,
                            "Accept": "application/json",
                            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                            "Referer": "https://dash.cloudflare.com/",
                        },
                        timeout=20
                    )
                    log_step(f"Strategy D permission_groups status: {pg_resp.status_code}")
                    wa_read_id = None
                    wa_write_id = None
                    if pg_resp.status_code == 200:
                        pg_data = pg_resp.json()
                        groups = pg_data.get("result") or []
                        for g in groups:
                            gname = g.get("name", "")
                            if gname == "Workers AI Read":
                                wa_read_id = g["id"]
                            elif gname == "Workers AI Write":
                                wa_write_id = g["id"]
                        if not wa_read_id:
                            wa_read_id = next(
                                (g["id"] for g in groups
                                 if "Workers AI" in g.get("name", "") and "Metadata" not in g.get("name", "")),
                                None
                            )
                    if wa_read_id:
                        log_step(f"Strategy D: Workers AI perm group: {wa_read_id}")
                    else:
                        # Fallback: use known hardcoded permission group IDs
                        wa_read_id = "a92d2450e05d4e7bb7d0a64968f83d11"
                        wa_write_id = "bacc64e0f6c34fc0883a1223f938a104"
                        log_step(f"Strategy D: Using hardcoded perm group IDs")

                    # Step 2: Create token via CF API
                    perm_groups = [{"id": wa_read_id}]
                    if wa_write_id:
                        perm_groups.append({"id": wa_write_id})
                    token_payload = {
                        "name": "9router-workers-ai",
                        "policies": [{
                            "effect": "allow",
                            "resources": {f"com.cloudflare.api.account.{account_id}": "*"},
                            "permission_groups": perm_groups,
                        }],
                    }
                    tok_resp = _req_d.post(
                        "https://api.cloudflare.com/client/v4/user/tokens",
                        json=token_payload,
                        headers={
                            "Cookie": cookie_str,
                            "Content-Type": "application/json",
                            "Accept": "application/json",
                            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                            "Referer": "https://dash.cloudflare.com/profile/api-tokens",
                            "Origin": "https://dash.cloudflare.com",
                        },
                        timeout=20
                    )
                    log_step(f"Strategy D token create status: {tok_resp.status_code}")
                    if tok_resp.status_code in (200, 201):
                        tok_data = tok_resp.json()
                        if tok_data.get("success") and tok_data.get("result", {}).get("value"):
                            workers_ai_token = tok_data["result"]["value"]
                            log_step(f"Strategy D token created: {workers_ai_token[:10]}...")
                        else:
                            log_step(f"Strategy D token failed: {tok_data.get('errors', 'unknown')}")
                    else:
                        log_step(f"Strategy D HTTP error: {tok_resp.text[:300]}")
                else:
                    log_step("Strategy D: No cookies available")
            except Exception as sde:
                log_step(f"Strategy D error: {sde}")

        # ── Strategy E: UI form final fallback — navigate to create-token page directly ──
        if not workers_ai_token:
            log_step("Strategy E: UI form final fallback — /profile/api-tokens/create-token...")
            try:
                # Navigate directly to the token creation page
                for _e_url in [
                    "https://dash.cloudflare.com/profile/api-tokens/create-token",
                    "https://dash.cloudflare.com/profile/api-tokens/create",
                    f"https://dash.cloudflare.com/{account_id}/api-tokens/create-token" if account_id else "",
                    f"https://dash.cloudflare.com/{account_id}/api-tokens/create" if account_id else "",
                ]:
                    if not _e_url:
                        continue
                    try:
                        page.goto(_e_url, wait_until="domcontentloaded", timeout=20000)
                        time.sleep(3)
                        _cur = page.url
                        log_step(f"Strategy E nav: {_cur}")
                        if "api-tokens" in _cur and "create" in _cur:
                            break
                    except Exception:
                        continue

                # Dismiss any consent dialogs
                try:
                    dismiss_consent_dialogs(page)
                except Exception:
                    pass
                time.sleep(2)
                page.screenshot(path="/tmp/cf_strategy_e_page.png")

                # Try "Edit Cloudflare Workers" template first (simpler than Workers AI)
                _e_template_clicked = False
                for _tmpl_name in ["Workers AI", "Edit Cloudflare Workers", "Read Cloudflare Workers"]:
                    if _e_template_clicked:
                        break
                    try:
                        _tmpl_result = page.evaluate(f"""
                            () => {{
                                const btns = Array.from(document.querySelectorAll('button, a'));
                                for (const btn of btns) {{
                                    if (btn.textContent.trim() === 'Use template') {{
                                        let el = btn.parentElement;
                                        for (let i = 0; i < 6; i++) {{
                                            if (el && el.textContent.includes('{_tmpl_name}')) {{
                                                btn.click();
                                                return 'clicked ' + '{_tmpl_name}';
                                            }}
                                            el = el ? el.parentElement : null;
                                        }}
                                    }}
                                }}
                                return 'template not found: ' + '{_tmpl_name}';
                            }}
                        """)
                        log_step(f"Strategy E template ({_tmpl_name}): {_tmpl_result}")
                        if "clicked" in str(_tmpl_result):
                            _e_template_clicked = True
                            time.sleep(3)
                    except Exception:
                        continue

                if _e_template_clicked:
                    # Template pre-fills the form — rename and continue
                    try:
                        for name_sel in ["input[name*='name' i]", "input[placeholder*='name' i]", "input[type='text']:first-of-type"]:
                            try:
                                el = page.locator(name_sel).first
                                if el.count() > 0 and el.is_visible(timeout=2000):
                                    el.click(click_count=3)
                                    el.fill("9router-workers-ai")
                                    break
                            except Exception:
                                continue
                    except Exception:
                        pass

                    # Click Continue to summary
                    time.sleep(1)
                    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                    time.sleep(1)
                    for cont_sel in ["button:has-text('Continue to summary')", "button:has-text('Continue')", "button:has-text('Review')"]:
                        try:
                            cb = page.locator(cont_sel).first
                            if cb.count() > 0 and cb.is_visible(timeout=3000):
                                cb.click()
                                time.sleep(3)
                                log_step(f"Strategy E continue: {cont_sel}")
                                break
                        except Exception:
                            continue

                    # Click Create Token on summary page
                    time.sleep(2)
                    page.screenshot(path="/tmp/cf_strategy_e_summary.png")
                    for ct_sel in ["button:has-text('Create Token')", "input[value*='Create Token']", "button[type='submit']"]:
                        try:
                            ct = page.locator(ct_sel).first
                            if ct.count() > 0 and ct.is_visible(timeout=5000):
                                ct.click()
                                time.sleep(5)
                                log_step(f"Strategy E create token: {ct_sel}")
                                break
                        except Exception:
                            continue

                    # Extract token from result page
                    try:
                        _e_body = page.inner_text("body")
                        import re as _re_e
                        _e_cfut = _re_e.search(r'\b(cfut_[A-Za-z0-9_\-]{30,})\b', _e_body)
                        if _e_cfut:
                            workers_ai_token = _e_cfut.group(1)
                            log_step(f"Strategy E token from body: {workers_ai_token[:12]}...")
                        else:
                            # Try broader pattern
                            _e_tok = _re_e.search(r'\b([a-zA-Z0-9_\-]{40,})\b', _e_body)
                            if _e_tok and len(_e_tok.group(1)) > 30:
                                workers_ai_token = _e_tok.group(1)
                                log_step(f"Strategy E token (broad): {workers_ai_token[:12]}...")
                    except Exception:
                        pass

                    # Also try selector-based extraction
                    if not workers_ai_token:
                        for tok_sel in ["code", "input[readonly]", "[data-testid='token-value']", ".cf-input-code"]:
                            try:
                                tel = page.locator(tok_sel).first
                                if tel.is_visible(timeout=2000):
                                    tval = (tel.input_value() if "input" in tok_sel else tel.text_content()) or ""
                                    tval = tval.strip()
                                    if tval and len(tval) > 10 and ' ' not in tval:
                                        workers_ai_token = tval
                                        log_step(f"Strategy E token from selector: {tval[:12]}...")
                                        break
                            except Exception:
                                continue

                    # Intercept via route as well
                    if not workers_ai_token:
                        try:
                            page.screenshot(path="/tmp/cf_strategy_e_result.png")
                            log_step("Strategy E: no token found from page content")
                        except Exception:
                            pass

            except Exception as see:
                log_step(f"Strategy E error: {see}")
                try:
                    page.screenshot(path="/tmp/cf_strategy_e_err.png")
                except Exception:
                    pass

        if not workers_ai_token:
            die("Tidak ada API key yang bisa digunakan")


        log_step("Selesai! Menyimpan kredensial ke 9router...")
        success(workers_ai_token, account_id, args.email)


if __name__ == "__main__":
    main()
