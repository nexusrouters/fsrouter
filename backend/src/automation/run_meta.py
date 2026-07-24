#!/usr/bin/env python3
"""run_meta.py — Auto-create Meta AI account + API key (no proxy, ncaori temp mail).
Deploys to DigitalOcean US server. Auto-generates email+password, runs meta_ai_signup.py,
extracts API key, saves to accounts.json.
"""
import argparse
import json
import os
import subprocess
import sys
import random
import string

HERE = os.path.dirname(os.path.abspath(__file__))


def gen_password():
    # Meta requires strong password (min 8, mixed). Use 16 chars.
    chars = string.ascii_letters + string.digits + "!@#$%"
    return "".join(random.choice(chars) for _ in range(16))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=1)
    ap.add_argument("--birthday", default="1995-06-15")
    ap.add_argument("--headless", action="store_true", default=True)
    ap.add_argument("--cc-number", default=os.environ.get("META_CC_NUMBER", "4426010011350623"), help="REAL Visa/Mastercard for billing (Meta requires valid CC before API key)")
    ap.add_argument("--cc-exp", default=os.environ.get("META_CC_EXP", "06/29"))
    ap.add_argument("--cc-cvc", default=os.environ.get("META_CC_CVC", "552"))
    ap.add_argument("--cc-name", default=os.environ.get("META_CC_NAME", "Mahfud"))
    ap.add_argument("--cc-postal", default=os.environ.get("META_CC_POSTAL", "56318"))
    ap.add_argument("--fake-cc", action="store_true", help="use FAKE test card (Meta rejects; testing only)")
    ap.add_argument("--out", default=os.path.join(HERE, "accounts.json"))
    ap.add_argument("--python", default=sys.executable)
    a = ap.parse_args()

    results = []
    script = os.path.join(HERE, "meta_ai_signup.py")
    for i in range(a.count):
        # generate email via mail.tm
        sys.path.insert(0, HERE)
        from mailtm_mail import generate_email
        email, tempmail_pw = generate_email()
        password = gen_password()
        cmd = [
            a.python, script,
            "--email", email,
            "--password", password,
            "--tempmail-password", tempmail_pw,
            "--birthday", a.birthday,
            "--apikey",
            "--vcc",
            "--headless" if a.headless else "",
        ]
        if a.cc_number:
            cmd += ["--cc-number", a.cc_number, "--cc-exp", a.cc_exp, "--cc-cvc", a.cc_cvc, "--cc-name", a.cc_name]
        elif a.fake_cc:
            cmd += ["--fake-cc"]
        cmd = [c for c in cmd if c]
        print(f"[run_meta] #{i+1} email={email} starting...", flush=True)
        proc = subprocess.run(cmd, capture_output=True, text=True)
        # parse last JSON line
        api_key = None
        ok = False
        for line in proc.stdout.strip().splitlines():
            try:
                d = json.loads(line)
                if d.get("api_key"):
                    api_key = d["api_key"]
                if d.get("ok"):
                    ok = True
            except Exception:
                pass
        entry = {
            "email": email,
            "password": password,
            "api_key": api_key,
            "ok": ok,
            "raw": proc.stdout[-500:] if not ok else "",
        }
        results.append(entry)
        print(f"[run_meta] #{i+1} ok={ok} api_key={'YES' if api_key else 'NO'}", flush=True)

    # save
    with open(a.out, "w") as f:
        json.dump(results, f, indent=2)
    print(f"[run_meta] saved {len(results)} accounts to {a.out}")


if __name__ == "__main__":
    main()
