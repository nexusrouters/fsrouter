"""mailtm_mail.py — Temp mail client for mail.tm (no API key, works from datacenter IPs).
Free disposable email. Auto-creates account + polls inbox for OTP.
"""
import json
import random
import string
import time
import urllib.request
import urllib.error

BASE = "https://api.mail.tm"
_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"


def _req(url, data=None, method="GET", token=None):
    headers = {"User-Agent": _UA, "Accept": "application/json", "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.status, resp.read().decode()


def generate_email():
    """Create a mail.tm account, return (email, password)."""
    s, b = _req(f"{BASE}/domains")
    doms = json.loads(b)
    if isinstance(doms, dict):
        doms = doms.get("hydra:member", [])
    dom = doms[0]["domain"] if isinstance(doms[0], dict) else doms[0]
    name = "".join(random.choice(string.ascii_lowercase) for _ in range(12))
    addr = f"{name}@{dom}"
    pw = "X" + "".join(random.choice(string.ascii_letters + string.digits) for _ in range(12)) + "x"
    s, b = _req(f"{BASE}/accounts", json.dumps({"address": addr, "password": pw}).encode(), "POST")
    if s not in (200, 201):
        raise RuntimeError(f"mail.tm create failed: {s} {b[:120]}")
    return addr, pw


def get_inbox(email, password, timeout=120):
    """Login, poll inbox, return OTP code or None."""
    # get token
    s, b = _req(f"{BASE}/token", json.dumps({"address": email, "password": password}).encode(), "POST")
    tok = json.loads(b).get("token")
    if not tok:
        return None
    deadline = time.time() + timeout
    seen = set()
    while time.time() < deadline:
        try:
            s, b = _req(f"{BASE}/messages", token=tok)
            msgs = json.loads(b).get("hydra:member", [])
            for m in msgs:
                mid = m.get("id", "")
                if mid in seen:
                    continue
                seen.add(mid)
                # fetch detail
                s2, b2 = _req(f"{BASE}/messages/{mid}", token=tok)
                detail = json.loads(b2)
                text = detail.get("text", "") or detail.get("html", "") or ""
                code = _extract_otp(text)
                if code:
                    return code
        except Exception:
            pass
        time.sleep(4)
    return None


def _extract_otp(text):
    if not text:
        return None
    import re
    # Meta sends 6-digit codes
    for pat in [r"\b(\d{6})\b", r"code[:\s]+(\d{6})", r"verification[^<]*?(\d{6})"]:
        g = re.search(pat, text, re.I)
        if g:
            return g.group(1)
    return None
