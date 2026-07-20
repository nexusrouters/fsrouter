import asyncio
from camoufox import AsyncCamoufox

async def main():
    print("Launching stealth browser...")
    try:
        async with AsyncCamoufox(headless=True) as browser:
            page = await browser.new_page()
            await page.goto("https://accounts.x.ai/sign-up", wait_until="networkidle", timeout=30000)
            
            # Dismiss OneTrust
            try:
                cookie_btn = page.locator("button#onetrust-accept-btn-handler").first
                await cookie_btn.click(timeout=3000)
                await asyncio.sleep(1)
            except: pass
                
            # Click sign up with email
            try:
                signup_email_btn = page.locator("button:has-text('Sign up with email')").first
                await signup_email_btn.click(timeout=5000)
                await asyncio.sleep(1)
            except: pass
                
            # React Fill email
            await page.wait_for_selector("input[type='email']", timeout=10000)
            await page.evaluate("""() => {
                const el1 = document.querySelector("input[type='email']");
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                setter.call(el1, "test-user-fs2@nguprus.app");
                el1.dispatchEvent(new Event('input', { bubbles: true }));
                el1.dispatchEvent(new Event('change', { bubbles: true }));
            }""")
            print("Email Form filled.")
            await asyncio.sleep(1)
            
            # Click submit (Sign up)
            submit_btn = page.locator("button[type='submit'], button:has-text('Sign up')").first
            await submit_btn.click(timeout=5000)
            print("Step 1 submitted!")
            await asyncio.sleep(5)
            
            # Screenshot step 2
            await page.screenshot(path="/tmp/grok_step2.png")
            print("Screenshot saved to /tmp/grok_step2.png")
            
            # Get inputs
            inputs = await page.evaluate("""() => {
                return Array.from(document.querySelectorAll('input')).map(i => ({
                    type: i.type,
                    name: i.name,
                    id: i.id,
                    placeholder: i.placeholder
                }));
            }""")
            print("Inputs at Step 2:", inputs)
            
    except Exception as e:
        print("Error:", e)

if __name__ == "__main__":
    asyncio.run(main())