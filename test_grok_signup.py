import asyncio
import time
import requests
from camoufox import AsyncCamoufox

FSM_KEY = "tm_4fa4e144a845d77d204140ee477264ff"

def get_otp(email):
    for i in range(12):
        print(f"Polling OTP for {email}...")
        try:
            r = requests.get(
                "https://fsmail.nguprus.app/api/emails",
                headers={"Authorization": f"Bearer {FSM_KEY}"},
                params={"address": email},
                timeout=10
            ).json()
            items = r.get("hydra:member") or r.get("items") or r.get("data") or []
            for item in items:
                text = item.get("intro", "") + " " + item.get("text", "") + " " + item.get("subject", "")
                import re
                m = re.search(r"\b(\d{6})\b", text)
                if m:
                    return m.group(1)
        except Exception as e:
            print("Error polling:", e)
        time.sleep(2)
    return None

async def main():
    email = f"test_dev_{int(time.time())}@nguprus.app"
    print(f"Testing signup with {email}...")
    
    # Precreate inbox
    requests.post(
        "https://fsmail.nguprus.app/api/accounts",
        headers={"Authorization": f"Bearer {FSM_KEY}", "Content-Type": "application/json"},
        json={"address": email, "password": "SafePassword123!"}
    )

    try:
        async with AsyncCamoufox(headless=True) as browser:
            page = await browser.new_page()
            print("Navigating to sign up...")
            await page.goto("https://accounts.x.ai/sign-up", wait_until="domcontentloaded", timeout=45000)
            await asyncio.sleep(4)

            # Click sign up with email
            try:
                btn = page.locator("button:has-text('Sign up with email')").last
                await btn.click(force=True, timeout=5000)
            except Exception:
                pass
            await asyncio.sleep(2)

            # Fill email
            await page.wait_for_selector("input[type='email']", timeout=15000)
            el = page.locator("input[type='email']").first
            await el.fill(email)
            await asyncio.sleep(1)

            # Click submit
            sub = page.locator("button[type='submit'], button:has-text('Sign up')").last
            await sub.click(force=True)
            print("Submitted email, waiting 5s...")
            await asyncio.sleep(5)

            # Get OTP
            otp = get_otp(email)
            print("Got OTP:", otp)

            if not otp:
                print("OTP not received!")
                return

            # Fill OTP
            await page.wait_for_selector("input[name='code'], input[type='text']", timeout=15000)
            code_input = page.locator("input[name='code'], input[type='text']").first
            await code_input.click(force=True)
            await code_input.fill(otp)
            await asyncio.sleep(1)

            # Click Confirm Email
            print("Clicking confirm email...")
            try:
                # the new robust click handler
                await page.evaluate("""() => {
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
            except Exception as e:
                print("JS click failed:", e)

            await asyncio.sleep(1)
            try:
                confirm_btn = page.locator("button:has-text('Confirm email'), button:has-text('Verify')").last
                await confirm_btn.click(force=True, timeout=3000)
            except Exception:
                pass

            print("Waiting 5s after OTP confirm click...")
            await asyncio.sleep(5)
            
            await page.screenshot(path="/tmp/grok_after_otp.png")
            print("Screenshot saved to /tmp/grok_after_otp.png")
            
    except Exception as e:
        print("Fatal error in test:", e)

if __name__ == "__main__":
    asyncio.run(main())