from camoufox.sync_api import Camoufox
import traceback
#!/usr/bin/env python3
"""
meta_ai_signup.py — Auto-create a Meta account + dev.meta.ai (Meta Model API) access.
Adapted from the Grok GAC signup pattern (backend/src/automation/grok_cli_gac.py).

Flow (verified manually 2026-07-22 / 07-23):
  1. GET https://dev.meta.ai/  -> redirects to auth.meta.com
  2. Click "Use mobile number or email"
  3. Type email -> Continue
  4. "Create a new account" -> pick birthday (18+) via custom dropdowns + password -> Confirm
  5. OTP sent to email -> poll Fsmail (or IMAP) for the 6-digit code -> submit
  6. Account created.
  7. (optional --apikey)  GET /api-keys -> click "Create API key" -> copy key
  8. (optional --vcc)     GET /billing  -> add VCC (VISA) -> Berikutnya (no OTP needed)

NOTE: dev.meta.ai (Meta Model API) is REGION-LOCKED. Running from a datacenter
IP yields "Model API isn't available in your region". Pass --proxy with a
residential proxy in a supported region (US/EU) to get past it.

Usage:
  python3 meta_ai_signup.py \
    --email=you@example.com --password='...' --birthday=1990-01-15 \
    --proxy=http://user:pass@host:port \
    --fsmail-base-url=https://fsmail.nguprus.app --fsmail-api-key=XXX \
    --apikey --vcc --headless=1
"""
import argparse
import json
import re
import sys
import time
import urllib.request
import urllib.error
import random
from datetime import datetime, timedelta

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print(json.dumps({"ok": False, "error": "playwright not installed"}))
    sys.exit(1)


def log(msg):
    # Print normal log
    sys.stderr.write(f"[meta-signup] {msg}\n")
    sys.stderr.flush()
    # Print JSON step for FSRouter UI
    print(json.dumps({"step": msg}), flush=True)


def fsmail_get_latest_otp(base_url, api_key, email, timeout=120):
    """Poll Fsmail inbox messages directly and parse OTP from content."""
    deadline = time.time() + timeout
    alias = email.split('@')[0]
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) FSRouterBot/1.0"
    }
    
    def strip_html(html_content):
        if not html_content: return ""
        text = re.sub(r'<style[\s\S]*?<\/style>', ' ', html_content, flags=re.I)
        text = re.sub(r'<[^>]+>', ' ', text)
        text = text.replace("&nbsp;", " ").replace("&amp;", "&").replace("&quot;", '"')
        return re.sub(r'\s+', ' ', text).strip()
    
    checked_msg_ids = set()
    
    while time.time() < deadline:
        try:
            url = f"{base_url}/api/inboxes/{urllib.parse.quote(alias)}/messages"
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=15) as r:
                data = json.loads(r.read().decode())
            
            messages = data.get("messages") or []
            for msg in messages:
                msg_id = msg.get("id")
                if msg_id and msg_id not in checked_msg_ids:
                    detail_url = f"{base_url}/api/messages/{msg_id}"
                    detail_req = urllib.request.Request(detail_url, headers=headers)
                    with urllib.request.urlopen(detail_req, timeout=15) as dr:
                        detail_data = json.loads(dr.read().decode())
                    
                    message_info = detail_data.get("message") or {}
                    subject = message_info.get("subject", "") or ""
                    html = message_info.get("html", "") or ""
                    text = message_info.get("text", "") or ""
                    
                    cleaned_html = strip_html(html)
                    combined_text = f"{subject} {text} {cleaned_html}"
                    match = re.search(r'\b(\d{6})\b', combined_text)
                    if match:
                        code = match.group(1)
                        log(f"Extracted 6-digit OTP from email detail: {code}")
                        return code
                    
                    checked_msg_ids.add(msg_id)
        except Exception as e:
            log(f"fsmail poll err: {e}")
        time.sleep(5)
    return None


def pick_dropdown(page, combo_index, value_text):
    try:
        page.locator('[role="combobox"]').nth(combo_index).click()
        time.sleep(0.6)
        page.get_by_text(value_text, exact=True).first.click()
        time.sleep(0.4)
        return True
    except Exception as e:
        log(f"pick_dropdown {value_text} err: {e}")
        return False


def gen_visa_card():
    """Generate a VISA test card from BIN 539371000872 + 4 random digits.
    Expiry fixed 05/31, CVV random 3 digits."""
    body = "539371000872" + "".join(random.choice("0123456789") for _ in range(4))
    # Luhn check digit
    def luhn(num):
        digits = [int(d) for d in num]
        odd = digits[-1::-2]
        even = digits[-2::-2]
        total = sum(odd) + sum(sum(divmod(d * 2, 10)) for d in even)
        return (10 - (total % 10)) % 10
    check = luhn(body)
    number = body + str(check)
    cvv = "".join(random.choice("0123456789") for _ in range(3))
    return {"number": number, "exp": "05/31", "cvv": cvv}


def create_api_key(page):
    """Navigate to /api-keys and click 'Create API key', return the key string."""
    try:
        page.goto("https://dev.meta.ai/api-keys", wait_until="domcontentloaded", timeout=45000)
        time.sleep(3)
        time.sleep(2)
        # dismiss any dialog
        try:
            page.get_by_role("button", name="Create API key").first.click()
        except Exception:
            page.get_by_text("Create API key").first.click()
        time.sleep(2.5)
        # key usually shown in a <code> or input or pre
        key = None
        for sel in ['input[readonly]', 'code', 'pre', '.token', '[role="textbox"]']:
            try:
                el = page.locator(sel).first
                if el.count():
                    txt = el.input_value() if sel.startswith("input") else el.inner_text()
                    m = re.search(r"(maa-[A-Za-z0-9_\-]{20,}|[A-Za-z0-9]{32,})", txt or "")
                    if m:
                        key = m.group(1)
                        break
            except Exception:
                pass
        if not key:
            # fallback: scrape page text
            txt = page.content()
            m = re.search(r"(maa-[A-Za-z0-9_\-]{20,}|[A-Za-z0-9]{32,})", txt)
            if m:
                key = m.group(1)
        return key
    except Exception as e:
        log(f"create_api_key err: {e}")
        return None


def add_vcc(page):
    """Navigate to /billing and add a VISA VCC. Returns ok/error."""
    try:
        card = gen_visa_card()
        page.goto("https://dev.meta.ai/billing", wait_until="domcontentloaded", timeout=45000)
        time.sleep(3)
        time.sleep(2)
        # click "Tambahkan metode pembayaran" / "Add payment method"
        try:
            page.get_by_text("Tambahkan metode pembayaran").first.click()
        except Exception:
            try:
                page.get_by_role("button", name="Add payment method").first.click()
            except Exception:
                page.get_by_text("metode pembayaran").first.click()
        time.sleep(2)
        # fill card fields (detect stripe or generic payment iframe)
        target = page
        for frame in page.frames:
            if "stripe" in frame.url.lower() or "elements" in frame.url.lower():
                target = frame
                break
        
        # fallback: jika target main page tidak ada input tapi ada iframe, gunakan iframe pertama yang valid
        if target == page:
            for frame in page.frames:
                if frame != page and (frame.locator('input').count() > 0 or "card" in frame.url.lower()):
                    target = frame
                    break

        target.locator('input[name*="cardnumber" i], input[aria-label*="card" i], input[placeholder*="card" i], input[id*="card" i]').first.press_sequentially(card["number"], delay=100)
        time.sleep(0.5)
        target.locator('input[name*="exp" i], input[placeholder*="BB" i], input[aria-label*="expir" i], input[name*="expiry" i]').first.press_sequentially("0531", delay=100)
        time.sleep(0.5)
        target.locator('input[name*="cvv" i], input[aria-label*="cvv" i], input[placeholder*="CVV" i], input[name*="cvc" i]').first.press_sequentially(card["cvv"], delay=100)
        time.sleep(0.5)
        # name on card
        try:
            target.locator('input[name*="name" i], input[aria-label*="name" i], input[placeholder*="Nama" i]').first.press_sequentially("Fud One", delay=100)
        except Exception:
            pass
        time.sleep(0.5)
        # "Berikutnya" / "Next"
        try:
            page.get_by_role("button", name="Berikutnya").first.click()
        except Exception:
            try:
                page.get_by_role("button", name="Next").first.click()
            except Exception:
                page.get_by_text("Berikutnya").first.click()
        time.sleep(4)
        html = page.content()
        ok = ("berhasil" in html.lower() or "saved" in html.lower() or "success" in html.lower()
              or "metode pembayaran" in html.lower())
        return {"ok": ok, "card": card["number"], "exp": card["exp"], "cvv": card["cvv"], "note": "VCC added (no OTP required per user)."}
    except Exception as e:
        log(f"add_vcc err: {e}")
        return {"ok": False, "error": str(e)}


def run(args):
    import urllib.parse

    if getattr(args, "stagger_delay", 0) > 0:
        log(f"Stagger delay active: sleeping for {args.stagger_delay}s before browser launch")
        time.sleep(args.stagger_delay)

    email = args.email
    password = args.password
    try:
        bd = datetime.strptime(args.birthday, "%Y-%m-%d")
    except Exception:
        bd = datetime(1990, 1, 15)
    month_name = bd.strftime("%B")
    day_str = str(bd.day)
    year_str = str(bd.year)

    proxy = None
    if args.proxy:
        try:
            if "@" in args.proxy:
                # parse http://user:pass@host:port
                left, right = args.proxy.split("@")
                scheme = "http"
                if args.proxy.startswith("https"):
                    scheme = "https"
                elif args.proxy.startswith("socks5"):
                    scheme = "socks5"
                
                left_clean = left.replace("http://", "").replace("https://", "").replace("socks5://", "")
                user, pw = left_clean.split(":")
                proxy = {
                    "server": f"{scheme}://{right}",
                    "username": user,
                    "password": pw
                }
            else:
                proxy = {"server": args.proxy}
        except Exception as e:
            log(f"Failed to parse proxy string: {e}")
            proxy = {"server": args.proxy}

    launch_kwargs = {
        "headless": args.headless,
        "proxy": proxy,
        "geoip": True,
        "humanize": True,
    }
    # Clean up None values
    launch_kwargs = {k: v for k, v in launch_kwargs.items() if v is not None}

    result = {"ok": False}
    try:
        with Camoufox(**launch_kwargs) as browser:
            # Di Camoufox persistent context, `browser` adalah `BrowserContext`
            context = browser
            page = browser.new_page()
            page.goto("https://dev.meta.ai/", wait_until="domcontentloaded", timeout=45000)
            time.sleep(3)
            log("Waiting for Use mobile number or email button...")
            page.get_by_text("Use mobile number or email").click()
            time.sleep(1.2)
            page.locator('input[type="text"], input:not([type])').first.fill(email)
            time.sleep(0.4)
            page.get_by_role("button", name="Continue").click()
            time.sleep(2.5)

            pick_dropdown(page, 0, month_name)
            pick_dropdown(page, 1, day_str)
            pick_dropdown(page, 2, year_str)
            page.locator('input[type="password"]').first.fill(password)
            time.sleep(0.5)
            page.get_by_role("button", name="Confirm").click()
            time.sleep(5)

            html = page.content()
            if "isn't available in your region" in html or "not available in your region" in html:
                result = {"ok": False, "error": "REGION_LOCKED: Meta Model API not available in this region. Use a residential proxy in US/EU."}
                browser.close()
                return result

            if not re.search(r"code|verification|confirm.*email|we sent|enter", html, re.I):
                result = {"ok": False, "error": "No OTP screen after Confirm. HTML snippet: " + html[:300]}
                browser.close()
                return result

            otp = None
            if args.fsmail_api_key:
                otp = fsmail_get_latest_otp(args.fsmail_base_url, args.fsmail_api_key, email, timeout=args.otp_timeout)
            if not otp:
                result = {"ok": False, "error": "OTP_NOT_RECEIVED", "need_otp": True}
                browser.close()
                return result

            digits = re.findall(r"\d", otp)[:6]
            otp_box = page.locator('input[inputmode="numeric"], input[maxlength="1"], input[name*="code" i]').first
            try:
                otp_box.fill("".join(digits))
            except Exception:
                for i, d in enumerate(digits):
                    page.locator('input[inputmode="numeric"]').nth(i).fill(d)
            time.sleep(3)

            html2 = page.content()
            if "something went wrong" in html2.lower():
                result = {"ok": False, "error": "OTP_FAILED: " + html2[:200]}
                browser.close()
                return result

            result = {
                "ok": True,
                "status": "success",
                "email": email,
                "cookies": context.cookies(),
                "note": "Meta account created.",
            }

            # Step 7: add VCC (MUST BE BEFORE API KEY!)
            if args.vcc:
                vcc = add_vcc(page)
                result["vcc"] = vcc

            # Step 8: create API key
            if args.apikey:
                key = create_api_key(page)
                result["api_key"] = key
                if not key:
                    result["api_key_error"] = "Could not extract key from /api-keys UI"

            browser.close()
    except Exception as e:
        traceback.print_exc()
        result = {"ok": False, "error": str(e)}
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--email", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--birthday", default="1990-01-15")
    ap.add_argument("--proxy", default="")
    ap.add_argument("--fsmail-base-url", default="https://fsmail.nguprus.app")
    ap.add_argument("--fsmail-api-key", default="")
    ap.add_argument("--fsmail-domain", default="")
    ap.add_argument("--otp-timeout", type=int, default=120)
    ap.add_argument("--apikey", action="store_true", help="also create an API key at /api-keys")
    ap.add_argument("--vcc", action="store_true", help="also add a VISA VCC at /billing")
    ap.add_argument("--headless", action="store_true", default=False)
    ap.add_argument("--profiles-dir", default="")
    ap.add_argument("--stagger-delay", type=int, default=0)
    args = ap.parse_args()
    res = run(args)
    if not res.get("status"):
        res["status"] = "success" if res.get("ok") else "error"
    print(json.dumps(res))


if __name__ == "__main__":
    main()
