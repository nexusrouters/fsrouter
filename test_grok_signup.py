import asyncio
import sys
from camoufox import AsyncCamoufox

async def main():
    print("Launching headful stealth browser in Xvfb...")
    try:
        async with AsyncCamoufox(headless=False, geoip=True) as browser:
            page = await browser.new_page()
            print("Navigating to https://accounts.x.ai/sign-up ...")
            await page.goto("https://accounts.x.ai/sign-up", wait_until="networkidle", timeout=30000)
            
            title = await page.title()
            print("Loaded. Title:", title)
            
            content = await page.content()
            if "blocked" in content.lower() or "cloudflare" in content.lower() or "attention required" in title.lower():
                print("BLOCKED BY CLOUDFLARE!")
                await page.screenshot(path="/tmp/grok_xvfb_block.png")
                print("Screenshot saved to /tmp/grok_xvfb_block.png")
                return
                
            print("SUCCESS! Cloudflare Bypassed in Xvfb.")
            await page.screenshot(path="/tmp/grok_xvfb_success.png")
            print("Screenshot saved to /tmp/grok_xvfb_success.png")
            
            inputs = await page.locator("input").all()
            print(f"Found {len(inputs)} inputs:")
            for idx, inp in enumerate(inputs):
                print(f"  [{idx}] name={await inp.get_attribute('name')} type={await inp.get_attribute('type')}")
                
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    asyncio.run(main())