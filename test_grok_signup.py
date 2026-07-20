import asyncio
import time
from camoufox import AsyncCamoufox

async def main():
    print("Launching stealth browser...")
    async with AsyncCamoufox(headless=True) as browser:
        page = await browser.new_page()
        print("Navigating to signup page...")
        await page.goto("https://accounts.x.ai/sign-up", wait_until="networkidle", timeout=30000)
        
        # Dismiss Cookie
        try:
            await page.locator("button#onetrust-accept-btn-handler").first.click(timeout=3000)
            print("Cookie accepted")
            await asyncio.sleep(1)
        except:
            pass
            
        # Click sign up with email
        try:
            await page.locator("button:has-text('Sign up with email')").first.click(timeout=5000)
            print("Clicked Sign up with email")
            await asyncio.sleep(1)
        except Exception as e:
            print("Failed click button:", e)
            
        # Fill email
        await page.wait_for_selector("input[type='email']", timeout=10000)
        await page.fill("input[type='email']", "rendi6330-c51ek1p6-8ij2nom9@nguprus.app")
        print("Filled email. Taking screenshot before submit...")
        await page.screenshot(path="/tmp/grok_before_submit.png")
        
        # Click submit
        submit_btn = page.locator("button[type='submit'], button:has-text('Sign up')").first
        await submit_btn.click(timeout=5000)
        print("Form Step 1 submitted!")
        
        # Wait 8s for transitions / WAF check / OTP form
        await asyncio.sleep(8)
        
        # Capture HTML & screenshot
        await page.screenshot(path="/tmp/grok_after_submit_real.png")
        print("Screenshot saved to /tmp/grok_after_submit_real.png")
        
        content = await page.content()
        with open("/tmp/grok_after_submit.html", "w") as fh:
            fh.write(content)
        print("HTML saved to /tmp/grok_after_submit.html")
        
        # Check frames
        print("Frames present:")
        for f in page.frames:
            print(f"  Frame URL: {f.url}")
            
if __name__ == "__main__":
    asyncio.run(main())