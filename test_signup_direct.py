#!/usr/bin/env python3
"""One-off test: sign up an xAI account via email at the grok-com redirect URL.
Mirrors what the user did manually. Just verifies the signup reaches the
'Complete your sign up' / profile step. No device auth, no router handoff.
"""
import sys, json, time, re, urllib.request, urllib.parse
from camoufox.sync_api import Camoufox

def emit(o): print(json.dumps(o), flush=True)

FSM_KEY = "tm_4fa4e144a845d77d204140ee477264ff"
FSM_BASE = "https://fsmail.nguprus.app"
EMAIL = f"test_{int(time.time())}@nguprus.app"

def fsmail_get(path):
    url = FSM_BASE.rstrip("/") + "/api" + path
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {FSM_KEY}", "X-API-Key": FSM_KEY,
        "Content-Type": "application/json", "User-Agent": "Mozilla/5.0",
        "Accept": "application/json, */*"})
    return json.loads(urllib.request.urlopen(req, timeout=15).read())

def get_otp(email, timeout=90):
    alias = email.split("@")[0]
    deadline = time.time() + timeout
    seen = set()
    while time.time() < deadline:
        try:
            data = fsmail_get(f"/inboxes/{urllib.parse.quote(alias)}/messages")
            for m in data.get("messages", []):
                if m.get("id") in seen: continue
                seen.add(m.get("id"))
                subj = m.get("subject", "")
                if any(k in subj.lower() for k in ["x.ai","verification","code","security"]):
                    full = fsmail_get(f"/messages/{urllib.parse.quote(str(m.get('id')))}")
                    body = full.get("message", full)
                    txt = body.get("body") or body.get("html") or body.get("text") or ""
                    if not isinstance(txt, str): txt = str(txt)
                    # alnum 6-char code (X.AI sends XXX-XXX)
                    for pat in [r'(?i)confirmation code[:\s]+([A-Z0-9]{3})[-\s]?([A-Z0-9]{3})',
                                r'(?i)\b([A-Z0-9]{3})[-\s]([A-Z0-9]{3})\b']:
                        mm = re.findall(pat, txt)
                        if mm: return (mm[0][0]+mm[0][1]).upper()
                    for tok in re.findall(r'\b([A-Z0-9]{6})\b', txt):
                        if re.search(r'[A-Z]', tok): return tok.upper()
        except Exception: pass
        time.sleep(4)
    return None

def main():
    emit({"step": f"Signup test for {EMAIL}"})
    # precreate inbox
    try:
        urllib.request.urlopen(urllib.request.Request(
            FSM_BASE + "/api/inboxes", method="POST",
            data=json.dumps({"alias": EMAIL.split("@")[0], "domain": "nguprus.app"}).encode(),
            headers={"Authorization": f"Bearer {FSM_KEY}", "Content-Type": "application/json"}))
    except Exception: pass
    with Camoufox(headless=True, geoip=True) as browser:
        page = browser.new_page()
        page.set_viewport_size({"width": 1280, "height": 900})
        emit({"step": "goto sign-up?redirect=grok-com..."})
        page.goto("https://accounts.x.ai/sign-up?redirect=grok-com&return_to=%2F",
                  wait_until="domcontentloaded", timeout=45000)
        time.sleep(4)
        try:
            cb = page.locator("button#onetrust-accept-btn-handler").first
            if cb.count() and cb.is_visible(timeout=3000): cb.click(); time.sleep(1)
        except Exception: pass
        # click Sign up with email
        seb = page.locator("button:has-text('Sign up with email')").last
        if seb.count() and seb.is_visible(timeout=10000):
            seb.click(force=True); time.sleep(2)
        page.wait_for_selector("input[type='email']", timeout=10000)
        page.locator("input[type='email']").first.fill(EMAIL)
        time.sleep(1)
        sb = page.locator("button[type='submit'], button:has-text('Sign up')").first
        if sb.count() and sb.is_visible(): sb.click()
        else: page.keyboard.press("Enter")
        emit({"step": "submitted email, waiting OTP..."})
        page.wait_for_selector("input[name='code'], input[type='text']", timeout=15000)
        otp = get_otp(EMAIL)
        emit({"step": f"OTP={otp}"})
        if otp:
            ce = page.locator("input[name='code'], input[type='text']").first
            ce.click(force=True); ce.fill(otp); time.sleep(1)
            try:
                page.evaluate("""() => { const b=Array.from(document.querySelectorAll('button')).find(x=>(x.textContent.trim().toLowerCase()==='confirm email'||x.textContent.trim().toLowerCase()==='verify')&&x.offsetHeight>0); if(b){b.focus();b.click();} }""")
            except Exception: pass
            time.sleep(2)
            cb2 = page.locator("button:has-text('Confirm email'), button:has-text('Verify')").last
            if cb2.count() and cb2.is_visible(timeout=3000): cb2.click(force=True)
        time.sleep(4)
        page.screenshot(path="/tmp/signup_test.png")
        emit({"step": f"URL now: {page.url}"})
        emit({"step": f"buttons: {[b for b in [x.text_content() for x in page.query_selector_all('button')] if b and b.strip()][:15]}"})
        emit({"status": "done", "final_url": page.url})

if __name__ == "__main__":
    main()
