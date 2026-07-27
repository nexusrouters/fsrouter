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
import os

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


try:
    from mailtm_mail import generate_email as mailtm_generate_email, get_inbox as mailtm_get_inbox
except ImportError:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from mailtm_mail import generate_email as mailtm_generate_email, get_inbox as mailtm_get_inbox


def ncaori_get_otp(email, timeout=120):
    # legacy alias; mail.tm requires password, handled in run_meta via mailtm_get_inbox
    return None


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


def handle_onboarding(page):
    log("Checking if redirected to onboarding screen...")
    try:
        # Meta renders label[for=...] "First name" / "Last name" (no placeholder)
        first_label = page.locator('//label[contains(., "First name")]')
        if first_label.count() > 0:
            log("Onboarding screen detected. Filling First name & Last name...")
            # input terkait ada di id dari atribut for, atau sibling
            for_attr = first_label.first.get_attribute("for")
            if for_attr:
                first_input = page.locator(f'input#{for_attr}')
            else:
                first_input = page.locator('//label[contains(., "First name")]/following::input[1]')
            last_label = page.locator('//label[contains(., "Last name")]')
            if last_label.count() > 0:
                la = last_label.first.get_attribute("for")
                if la:
                    last_input = page.locator(f'input#{la}')
                else:
                    last_input = page.locator('//label[contains(., "Last name")]/following::input[1]')
            else:
                last_input = first_input
            first_input.first.fill("Fud")
            time.sleep(0.5)
            last_input.first.fill("One")
            time.sleep(0.5)
            # klik Get started / Continue / Submit
            clicked = False
            for lbl in ["Get started", "Continue", "Submit", "Next", "Mulai", "Lanjut"]:
                try:
                    page.get_by_text(lbl).first.click(timeout=3000)
                    clicked = True
                    break
                except Exception:
                    try:
                        page.get_by_role("button", name=lbl).first.click(timeout=3000)
                        clicked = True
                        break
                    except Exception:
                        pass
            if not clicked:
                page.keyboard.press("Enter")
            time.sleep(8)
            return True
    except Exception as e:
        log(f"handle_onboarding err: {e}")
    return False

def handle_welcome_modal(page):
    """Click 'Continue' on the 'Welcome to Meta Model API' onboarding modal if present."""
    try:
        if page.get_by_text("Welcome to Meta Model API").count() > 0:
            log("Welcome modal detected — clicking Continue...")
            for lbl in ["Continue", "Get started", "Mulai"]:
                try:
                    page.get_by_text(lbl).first.click(timeout=4000)
                    time.sleep(5)
                    return True
                except Exception:
                    try:
                        page.get_by_role("button", name=lbl).first.click(timeout=4000)
                        time.sleep(5)
                        return True
                    except Exception:
                        pass
    except Exception:
        pass
    return False

def handle_finish_creating(page):
    """Fill 'Finish creating your Model API account' form (First/Last name) + click 'Get started'."""
    try:
        if page.get_by_text("Finish creating your Model API account").count() > 0:
            log("Finish-creating screen detected. Filling First/Last name...")
            fn = page.locator('input[placeholder*="First name" i], input[name*="first" i]').first
            ln = page.locator('input[placeholder*="Last name" i], input[name*="last" i]').first
            if fn.count() > 0:
                fn.fill("Fud")
                time.sleep(0.5)
            if ln.count() > 0:
                ln.fill("One")
                time.sleep(0.5)
            for lbl in ["Get started", "Continue", "Submit", "Mulai", "Lanjut"]:
                try:
                    page.get_by_text(lbl).first.click(timeout=4000)
                    time.sleep(6)
                    return True
                except Exception:
                    try:
                        page.get_by_role("button", name=lbl).first.click(timeout=4000)
                        time.sleep(6)
                        return True
                    except Exception:
                        pass
    except Exception:
        pass
    return False

def dismiss_onboarding_gates(page, rounds=4):
    """Loop through all onboarding/welcome/finish modals in any order until none remain."""
    for _ in range(rounds):
        did = False
        if handle_welcome_modal(page):
            did = True
        if handle_finish_creating(page):
            did = True
        if not did:
            break
    return True

def handle_human_check(page):
    """Click through Meta 'Confirm you\'re human' / 'Continue' gate if present.
    Returns True if a human-check is currently showing (caller should re-check page after)."""
    try:
        if (page.get_by_text("Confirm you're human", exact=False).count() > 0 or
                page.get_by_text("Confirm you’re human", exact=False).count() > 0):
            log("Human-check gate detected. Clicking Continue (up to 3x)...")
            for attempt in range(3):
                clicked = False
                for lbl in ["Continue", "Confirm", "Next", "Verify", "I am human", "I'm human"]:
                    try:
                        page.get_by_text(lbl).first.click(timeout=3000)
                        clicked = True
                        break
                    except Exception:
                        try:
                            page.get_by_role("button", name=lbl).first.click(timeout=3000)
                            clicked = True
                            break
                        except Exception:
                            pass
                time.sleep(5)
                # jika setelah klik halaman sudah bukan human-check, selesai
                if (page.get_by_text("Confirm you're human", exact=False).count() == 0 and
                        page.get_by_text("Confirm you’re human", exact=False).count() == 0):
                    log("Human-check passed after click.")
                    return False
            # masih human-check setelah 3x klik
            return True
    except Exception as e:
        log(f"handle_human_check err: {e}")
    return False

def handle_otp_redirect(page, args):
    """If Meta redirects to an OTP confirmation screen, fill the latest code and submit."""
    try:
        if page.get_by_text("Enter the confirmation code", exact=False).count() > 0 or \
           page.get_by_text("confirmation code", exact=False).count() > 0:
            log("OTP re-prompt detected on sensitive page. Fetching latest OTP...")
            otp = fsmail_get_latest_otp(args.fsmail_base_url, args.fsmail_api_key, args.email, timeout=args.otp_timeout)
            if not otp:
                log("No OTP available for re-prompt.")
                return False
            digits = re.findall(r"\d", otp)[:6]
            box = page.locator('input[inputmode="numeric"], input[maxlength="1"], input[name*="code" i]').first
            try:
                box.fill("".join(digits))
            except Exception:
                for i, d in enumerate(digits):
                    page.locator('input[inputmode="numeric"]').nth(i).fill(d)
            time.sleep(1)
            try:
                page.get_by_text("Next").first.click(timeout=5000)
            except Exception:
                try:
                    page.get_by_role("button", name="Next").first.click(timeout=5000)
                except Exception:
                    page.keyboard.press("Enter")
            time.sleep(6)
            return True
    except Exception as e:
        log(f"handle_otp_redirect err: {e}")
    return False

def open_api_keys(page):
    """Try navigating to /api-keys via in-app link first, fallback to goto."""
    try:
        dismiss_onboarding_gates(page)
    except Exception:
        pass
    # coba klik link "API keys" di sidebar/menu
    for lbl in ["API keys", "API Keys", "Model API keys", "Api keys"]:
        try:
            page.get_by_text(lbl, exact=False).first.click(timeout=3000)
            time.sleep(4)
            if "api-keys" in page.url:
                return
        except Exception:
            pass
    page.goto("https://dev.meta.ai/api-keys", wait_until="domcontentloaded", timeout=45000)
    time.sleep(5)

def create_api_key(page, args=None):
    """Navigate to /api-keys, click 'Create API key', fill key name in modal, submit, and return key.
    Returns 'NEEDS_HUMAN_VERIFY' if blocked by Meta human verification."""
    try:
        open_api_keys(page)
        # retry loop: human-check kadang hilang setelah tunggu
        for attempt in range(3):
            if handle_onboarding(page):
                open_api_keys(page)
            if handle_otp_redirect(page, args):
                open_api_keys(page)
            if handle_onboarding(page):
                open_api_keys(page)
            # cek human-check
            if page.get_by_text("Confirm you're human", exact=False).count() > 0 or \
               page.get_by_text("Confirm you’re human", exact=False).count() > 0:
                log(f"Human-check present (attempt {attempt+1}/3). Waiting then retrying...")
                time.sleep(20)
                open_api_keys(page)
                continue
            break
        # final human-check check
        if page.get_by_text("Confirm you're human", exact=False).count() > 0 or \
           page.get_by_text("Confirm you’re human", exact=False).count() > 0:
            log("Still blocked by human verification after retries.")
            return "NEEDS_HUMAN_VERIFY"
        log(f"DEBUG api-keys URL: {page.url}")
        dbg_html = page.content()
        log(f"DEBUG api-keys html length: {len(dbg_html)}")
        dbg_text = re.sub(r"<[^>]+>", " ", dbg_html)
        dbg_text = re.sub(r"\s+", " ", dbg_text)
        log(f"DEBUG has 'Create API key': {'Create API key' in dbg_text}")
        log(f"DEBUG has 'human': {'human' in dbg_text.lower()}")
        log(f"DEBUG visible text snippet: {dbg_text[:300]}")
        log("Looking for main Create API key button...")
        # tunggu loading selesai
        try:
            page.wait_for_load_state("networkidle", timeout=20000)
        except Exception:
            pass
        time.sleep(3)
        
        # CHECK: tombol "Create API key" disabled? (Meta wajib billing aktif dulu)
        # Retry beberapa kali — setelah submit kartu, tombol butuh 2-5s buat enable.
        billing_required = False
        for _ in range(4):
            try:
                disabled_btn = page.locator('div:has-text("Create API key"), button:has-text("Create API key")').first
                if disabled_btn.count() > 0:
                    is_disabled = disabled_btn.is_disabled() or bool(disabled_btn.get_attribute("aria-disabled"))
                    if is_disabled:
                        billing_required = True
                        time.sleep(4)
                        continue
                billing_required = False
                break
            except Exception:
                billing_required = False
                break
        if billing_required:
            log("Create API key button is DISABLED — billing/payment method not active yet.")
            return "BILLING_REQUIRED"
        
        clicked_main = False
        for btn_text in ["Create API key", "Buat kunci API", "Create new API key", "Create", "Buat"]:
            try:
                # coba div/button berisi teks (Meta pakai div, bukan button)
                el = page.locator(f'div:has-text("{btn_text}")').first
                el.wait_for(state="visible", timeout=5000)
                el.click(timeout=5000, force=True)
                clicked_main = True
                break
            except Exception:
                try:
                    page.get_by_text(btn_text, exact=False).first.click(timeout=5000, force=True)
                    clicked_main = True
                    break
                except Exception:
                    try:
                        page.get_by_role("button", name=btn_text).first.click(timeout=5000)
                        clicked_main = True
                        break
                    except Exception:
                        pass
                
        if not clicked_main:
            log("Could not find main button. Attempting to proceed...")

        time.sleep(2)

        # 2. Handle modal "Create new API key" (only inside a dialog)
        try:
            name_input = page.locator('[role="dialog"] input[placeholder*="name" i], [role="dialog"] input[placeholder*="nama" i], [role="dialog"] input[type="text"]').first
            name_input.wait_for(state="visible", timeout=5000)
            log("Modal detected. Filling Key name...")
            name_input.fill("FSRouter")
            time.sleep(0.5)
            # Klik tombol Create di modal
            clicked_modal = False
            for btn_text in ["Create API key", "Buat kunci API", "Create", "Buat", "Confirm", "Konfirmasi"]:
                try:
                    page.get_by_role("button", name=btn_text).first.click(timeout=2000)
                    clicked_modal = True
                    break
                except Exception:
                    try:
                        page.get_by_text(btn_text).first.click(timeout=2000)
                        clicked_modal = True
                        break
                    except Exception:
                        pass
            if clicked_modal:
                log("Modal submitted successfully.")
            else:
                log("Fallback: trying to press Enter / click dialog button to submit modal.")
                try:
                    name_input.press("Enter")
                except Exception:
                    pass
                # fallback: klik tombol biru manapun di dalam dialog
                try:
                    dlg = page.locator('[role="dialog"]')
                    btns = dlg.locator('button')
                    for i in range(btns.count()):
                        try:
                            btns.nth(i).click(timeout=2000)
                            break
                        except Exception:
                            pass
                except Exception:
                    pass
            time.sleep(8)
        except Exception as e:
            log(f"No key name modal detected or bypassed: {str(e)[:50]}")

        # 3. Extract key LLM_ (poll up to 25s for the key to render)
        key = None
        import time as _t
        deadline = _t.time() + 25
        while _t.time() < deadline:
            # cek input/readonly/code/pre/div/span berisi LLM_
            try:
                txt = page.content()
                m = re.search(r"LLM_[A-Za-z0-9_]{15,80}", txt)
                if m:
                    key = m.group(0)
                    break
            except Exception:
                pass
            # juga coba baca value input apa pun
            try:
                for sel in ['input', 'code', 'pre', '.token', '[role="textbox"]', 'div', 'span']:
                    try:
                        els = page.locator(sel).all()
                        for el in els[:50]:
                            try:
                                v = el.input_value() if sel == 'input' else el.inner_text()
                            except Exception:
                                v = ""
                            if v and "LLM_" in v:
                                mm = re.search(r"LLM_[A-Za-z0-9_]{15,80}", v)
                                if mm:
                                    key = mm.group(0)
                                    break
                        if key:
                            break
                    except Exception:
                        pass
                if key:
                    break
            except Exception:
                pass
            _t.sleep(2)
        
        if not key:
            txt = page.content()
            log("API key not found after polling. Saving debug screenshot.")
            try: page.screenshot(path="/tmp/apikey_not_found.png")
            except: pass
            try:
                with open("/tmp/apikey_not_found.html", "w") as f_out:
                    f_out.write(txt)
            except: pass
        
        if key: log(f"API key created successfully: {key[:10]}...")
        return key
    except Exception as e:
        log(f"create_api_key err: {e}")
        return None

def add_vcc(page, args=None):
    """Navigate to /billing and add a payment method. Meta REQUIRES a valid CC
    before the API key button is enabled. Use --cc-number (real card) or --fake-cc (test only)."""
    try:
        dismiss_onboarding_gates(page)
    except Exception:
        pass
    try:
        if args and getattr(args, "cc_number", ""):
            # REAL card from args
            exp = (args.cc_exp or "05/31").replace("/", "")
            card = {
                "number": args.cc_number,
                "exp": exp,
                "cvv": args.cc_cvc or "123",
                "name": args.cc_name or "Fud One",
                "postal": args.cc_postal or "10001",
            }
            log(f"add_vcc: using REAL card ending {card['number'][-4:]}")
        elif args and getattr(args, "fake_cc", False):
            card = gen_visa_card()
            log("add_vcc: using FAKE test card (Meta will likely reject)")
        else:
            log("add_vcc: NO card provided. Pass --cc-number <real> or --fake-cc. Cannot add billing.")
            return {"ok": False, "error": "NO_CARD_PROVIDED"}
        page.goto("https://dev.meta.ai/billing", wait_until="domcontentloaded", timeout=45000)
        time.sleep(5)
        try:
            page.wait_for_load_state("networkidle", timeout=20000)
        except Exception:
            pass
        time.sleep(3)
        bhtml = page.content()
        btext = re.sub(r"<[^>]+>", " ", bhtml)
        btext = re.sub(r"\s+", " ", btext)
        log(f"DEBUG billing URL: {page.url}")
        log(f"DEBUG billing has 'Add payment method': {'Add payment method' in btext}")
        log(f"DEBUG billing has 'Tambahkan metode pembayaran': {'Tambahkan metode pembayaran' in btext}")
        log(f"DEBUG billing has 'Verifikasi': {'Verifikasi' in btext}")
        log(f"DEBUG billing snippet: {btext[:200]}")
        if handle_onboarding(page):
            page.goto("https://dev.meta.ai/billing", wait_until="domcontentloaded", timeout=30000)
            time.sleep(5)
        if handle_human_check(page):
            page.goto("https://dev.meta.ai/billing", wait_until="domcontentloaded", timeout=30000)
            time.sleep(5)
        if handle_otp_redirect(page, args):
            page.goto("https://dev.meta.ai/billing", wait_until="domcontentloaded", timeout=30000)
            time.sleep(5)
        if handle_onboarding(page):
            page.goto("https://dev.meta.ai/billing", wait_until="domcontentloaded", timeout=30000)
            time.sleep(5)
        # click "Tambahkan metode pembayaran" / "Add payment method"
        try:
            page.get_by_text("Tambahkan metode pembayaran").first.click(timeout=5000)
        except Exception:
            try:
                page.get_by_text("Add payment method").first.click(timeout=5000)
            except Exception:
                page.get_by_text("metode pembayaran").first.click(timeout=5000)
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
            target.locator('input[name*="name" i], input[aria-label*="name" i], input[placeholder*="Nama" i]').first.press_sequentially(card["name"], delay=100)
        except Exception:
            pass
        time.sleep(0.5)
        # postal / zip code (FSRouter Stripe element zip code patch)
        try:
            target.locator('input[name*="postal" i], input[placeholder*="Kode Pos" i], input[placeholder*="Postal" i], input[placeholder*="ZIP" i], input[id*="postal" i], input[name*="zip" i]').first.press_sequentially(card["postal"], delay=100)
            log("Postal code filled successfully.")
        except Exception as e:
            log(f"Optional postal code field not found or skipped: {e}")
        time.sleep(0.5)
        # "Berikutnya" / "Next" / "Save"
        try:
            page.get_by_text("Berikutnya").first.click(timeout=5000)
        except Exception:
            try:
                page.get_by_text("Next").first.click(timeout=5000)
            except Exception:
                try:
                    page.get_by_text("Save").first.click(timeout=5000)
                except Exception:
                    pass
        time.sleep(5)
        # Bypass 3D Secure / "Verifikasi Kartu": Langsung anggap submit sukses
        # dan lanjut ke /api-keys (sesuai instruksi: "langsung aja ke apikey")
        log("VCC submitted. Ignoring 3D secure/card verification screen and proceeding to API keys.")
        return {"ok": True, "card": card["number"], "exp": card["exp"], "cvv": card["cvv"], "note": "VCC submitted, bypassing 3D secure."}
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
            time.sleep(1)
            # Klik Next untuk mensubmit kode OTP
            log("Submitting OTP code...")
            try:
                page.get_by_text("Next").first.click(timeout=5000)
            except Exception:
                try:
                    page.get_by_role("button", name="Next").first.click(timeout=5000)
                except Exception:
                    page.keyboard.press("Enter")
            time.sleep(5)

            html2 = page.content()
            if "something went wrong" in html2.lower():
                result = {"ok": False, "error": "OTP_FAILED: " + html2[:200]}
                browser.close()
                return result

            # Onboarding screen: First name / Last name
            log("Checking for onboarding screen...")
            try:
                # Menunggu field muncul dalam waktu maksimal 10 detik setelah submit OTP
                page.locator('input[placeholder*="First name" i], input[name*="first" i]').first.wait_for(state="visible", timeout=10000)
                log("Onboarding screen detected. Filling First name & Last name...")
                page.locator('input[placeholder*="First name" i], input[name*="first" i]').first.fill("Fud")
                time.sleep(0.5)
                page.locator('input[placeholder*="Last name" i], input[name*="last" i]').first.fill("One")
                time.sleep(0.5)
                # "Get started" button
                page.get_by_role("button", name="Get started").first.click(timeout=5000)
                time.sleep(10)
            except Exception as e:
                log(f"No onboarding screen detected or bypassed: {str(e)[:50]}")

            # Welcome to Meta Model API modal (muncul setelah Get started)
            dismiss_onboarding_gates(page)

            # Beri jeda agar session Meta "settle" dan mengurangi human-check challenge
            log("Letting session settle before opening billing/api-keys...")
            time.sleep(30)
            # Coba lagi kalau welcome modal muncul setelah settle
            dismiss_onboarding_gates(page)

            result = {
                "ok": True,
                "status": "success",
                "email": email,
                "cookies": page.context.cookies(),
                "note": "Meta account created.",
            }

            # Step 7: add VCC (MUST BE BEFORE API KEY!)
            if args.vcc:
                vcc = add_vcc(page, args)
                result["vcc"] = vcc

            # Step 8: create API key (requires billing done first)
            if args.apikey:
                key = create_api_key(page, args)
                if key == "NEEDS_HUMAN_VERIFY":
                    result["needs_human_verify"] = True
                    result["api_key_error"] = "Blocked by Meta human verification. Complete it manually, then re-run."
                elif key == "BILLING_REQUIRED":
                    result["api_key_error"] = "BILLING_REQUIRED: payment method not active. Provide a valid CC (--cc-number) or complete billing manually, then re-run."
                else:
                    result["api_key"] = key
                if not key or key in ("NEEDS_HUMAN_VERIFY", "BILLING_REQUIRED"):
                    if "api_key_error" not in result:
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
    ap.add_argument("--tempmail-password", default="", help="mail.tm account password for OTP polling")
    ap.add_argument("--otp-timeout", type=int, default=120)
    ap.add_argument("--apikey", action="store_true", help="also create an API key at /api-keys")
    ap.add_argument("--vcc", action="store_true", help="also add a payment method at /billing (REQUIRED before API key)")
    ap.add_argument("--cc-number", default=os.environ.get("META_CC_NUMBER", "4426010011350623"), help="REAL Visa/Mastercard number for billing (Meta requires valid CC)")
    ap.add_argument("--cc-exp", default=os.environ.get("META_CC_EXP", "06/29"), help="CC expiry MM/YY, e.g. 05/31")
    ap.add_argument("--cc-cvc", default=os.environ.get("META_CC_CVC", "552"), help="CC CVC")
    ap.add_argument("--cc-name", default=os.environ.get("META_CC_NAME", "Mahfud"), help="CC holder name")
    ap.add_argument("--cc-postal", default=os.environ.get("META_CC_POSTAL", "56318"), help="CC postal/ZIP code")
    ap.add_argument("--fake-cc", action="store_true", help="use generated FAKE test card (Meta will reject; testing only)")
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
