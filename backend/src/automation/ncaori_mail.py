"""ncaori_mail.py — Temp mail client for ncaori.my.id / nca.my.id (no API key).
Ported from @wanglinsaputra/tempmail-wrapper NcaoriMail provider.
"""
import json
import random
import re
import sys
import time
import urllib.request
import urllib.error
import urllib.parse

BASE = "https://www.nca.my.id"
DOMAINS = ["ncaori.my.id", "nca.my.id"]

_WORDS1 = ['swift', 'crystal', 'storm', 'frost', 'shadow', 'ember', 'azure',
           'phantom', 'silver', 'iron', 'crimson', 'golden', 'neo', 'cosmic',
           'lunar', 'solar', 'dark', 'light', 'void', 'flux']
_WORDS2 = ['core', 'leaf', 'forge', 'wave', 'peak', 'gate', 'pulse', 'blade',
           'shard', 'drift', 'hive', 'node', 'edge', 'beacon', 'nova', 'moon', 'star', 'wind']


def generate_email():
    name = f"{random.choice(_WORDS1)}_{random.choice(_WORDS2)}"
    domain = random.choice(DOMAINS)
    return f"{name}@{domain}"


def _fetch(path, timeout=20):
    url = BASE + path
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def get_inbox(email, timeout=120):
    """Poll inbox for OTP. Returns 6-char code or None."""
    deadline = time.time() + timeout
    seen = set()
    while time.time() < deadline:
        try:
            data = _fetch(f"/api/emails?recipient={urllib.parse.quote(email)}")
            emails = data.get("emails", []) if isinstance(data, dict) else []
            for m in emails:
                mid = m.get("id", "")
                if mid in seen:
                    continue
                seen.add(mid)
                body = m.get("body_text") or m.get("body_html") or ""
                subject = m.get("subject", "")
                code = _extract_otp(subject + "\n" + body)
                if code:
                    return code
        except Exception:
            pass
        time.sleep(4)
    return None


def _extract_otp(text):
    if not text:
        return None
    # Meta sends numeric 6-digit codes typically
    for pat in [r"\b(\d{6})\b", r"code[:\s]+(\d{6})", r"(\d{6})"]:
        g = re.search(pat, text, re.I)
        if g:
            return g.group(1)
    return None


if __name__ == "__main__":
    # CLI helper: generate email, poll, print code as JSON
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--email", default="")
    ap.add_argument("--timeout", type=int, default=120)
    a = ap.parse_args()
    email = a.email or generate_email()
    print(json.dumps({"email": email}))
    sys.stdout.flush()
    if a.email:
        code = get_inbox(email, timeout=a.timeout)
        print(json.dumps({"otp": code}))
