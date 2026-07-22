#!/usr/bin/env python3
"""
meta_ai_signup.py — Auto-create a Meta account + dev.meta.ai (Meta Model API) access.
Adapted from the Grok GAC signup pattern (backend/src/automation/grok_cli_gac.py).

Flow (verified manually 2026-07-22):
  1. GET https://dev.meta.ai/  -> redirects to auth.meta.com
  2. Click "Use mobile number or email"
  3. Type email -> Continue
  4. "Create a new account" -> pick birthday (18+) via custom dropdowns + password -> Confirm
  5. OTP sent to email -> poll Fsmail (or IMAP) for the 6-digit code -> submit
  6. Account created. Session cookies returned.

NOTE: dev.meta.ai (Meta Model API) is REGION-LOCKED. Running from a datacenter
IP yields "Model API isn't available in your region". Pass --proxy with a
residential proxy in a supported region (US/EU) to get past it.

Usage:
  python3 meta_ai_signup.py \
    --email=you@example.com --password='...' --birthday=1990-01-15 \
    --proxy=http://user:pass@host:port \
    --fsmail-base-url=https://fsmail.nguprus.app --fsmail-api-key=XXX \
    --headless=1
"""
import argparse
import json
import re
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timedelta

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print(json.dumps({"ok": False, "error": "playwright not installed"}))
    sys.exit(1)


def log(msg):
    print(f"[meta-signup] {msg}", flush=True)


def fsmail_get_latest_otp(base_url, api_key, email, timeout=120):
    """Poll Fsmail for the most recent OTP addressed to `email`."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            req = urllib.request.Request(
                f"{base_url}/api/otps?email={urllib.parse.quote(email)}",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=15) as r:
                data = json.loads(r.read().decode())
            otps = data.get("otps") or data.get("data") or []
            for o in reversed(otps):
                if o.get("email") == email and not o.get("used"):
                    code = o.get("code") or o.get("otp")
                    if code:
                        return code
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


def run(args):
    import urllib.parse

    email = args.email
    password = args.password
    # birthday -> month/day/year
    try:
        bd = datetime.strptime(args.birthday, "%Y-%m-%d")
    except Exception:
        bd = datetime(1990, 1, 15)
    month_name = bd.strftime("%B")  # "January"
    day_str = str(bd.day)
    year_str = str(bd.year)

    proxy = None
    if args.proxy:
        proxy = {"server": args.proxy}

    launch_kwargs = {"headless": args.headless == 1, "args": ["--no-sandbox", "--disable-setuid-sandbox"]}
    if proxy:
        launch_kwargs["proxy"] = proxy

    result = {"ok": False}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(**launch_kwargs)
            context = browser.new_context()
            page = context.new_page()
            page.goto("https://dev.meta.ai/", wait_until="networkidle", timeout=30000)
            page.get_by_text("Use mobile number or email").click()
            time.sleep(1.2)
            page.locator('input[type="text"], input:not([type])').first.fill(email)
            time.sleep(0.4)
            page.get_by_role("button", name="Continue").click()
            time.sleep(2.5)

            # birthday
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

            # OTP
            otp = None
            if args.fsmail_api_key:
                otp = fsmail_get_latest_otp(args.fsmail_base_url, args.fsmail_api_key, email, timeout=args.otp_timeout)
            if not otp:
                # try generic 6-digit from page hint / manual
                result = {"ok": False, "error": "OTP_NOT_RECEIVED", "need_otp": True}
                browser.close()
                return result

            # input OTP (digits)
            digits = re.findall(r"\d", otp)[:6]
            otp_box = page.locator('input[inputmode="numeric"], input[maxlength="1"], input[name*="code" i]').first
            try:
                otp_box.fill("".join(digits))
            except Exception:
                for i, d in enumerate(digits):
                    page.locator('input[inputmode="numeric"]').nth(i).fill(d)
            time.sleep(3)

            # check success
            html2 = page.content()
            if "something went wrong" in html2.lower():
                result = {"ok": False, "error": "OTP_FAILED: " + html2[:200]}
                browser.close()
                return result

            # grab cookies
            cookies = context.cookies()
            result = {
                "ok": True,
                "email": email,
                "cookies": cookies,
                "note": "Meta account created. Use dev.meta.ai to generate a Model API key.",
            }
            browser.close()
    except Exception as e:
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
    ap.add_argument("--otp-timeout", type=int, default=120)
    ap.add_argument("--headless", type=int, default=1)
    args = ap.parse_args()
    print(json.dumps(run(args)))


if __name__ == "__main__":
    main()
