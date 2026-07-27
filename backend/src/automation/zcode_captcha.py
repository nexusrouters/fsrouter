"""
ZCode Aliyun Captcha solver — anti-detect build.

Strategy:
  1. Launch Chromium with a spoofed Windows Chrome fingerprint
     (navigator overrides + CDP client hints) so Aliyun's risk engine
     scores the session as a genuine desktop browser.
  2. Load AliyunCaptcha.js SDK from zcode.z.ai origin (referer carried),
     run startTracelessVerification(). If F001 (interactive slider),
     solve the slider with a human-like drag curve.
  3. Return {"verifyParam": "...", "region": "sgp"}.

NOTE: fingerprint spoofing alone does NOT bypass 3007 — Aliyun does
server-side risk scoring (IP reputation / TLS / behavioral). Pair this with
a RESIDENTIAL proxy (env ZCODE_CAPTCHA_PROXY) for best pass rate.
"""
import os
import sys
import json
import asyncio

from playwright.async_api import async_playwright

# ----- config pulled from live ZCode client configs endpoint -----
CAPTCHA_REGION = "sgp"
CAPTCHA_PREFIX = "no8xfe"
CAPTCHA_SCENE = "11xygtvd"
ALIYUN_SDK = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"

# spoofed Windows Chrome 124 fingerprint
FAKE_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
FAKE_PLATFORM = "Win32"
FAKE_HW_CONCURRENCY = 8
FAKE_DEVICE_MEMORY = 8
FAKE_LANG = ["en-US", "en"]
FAKE_TZ = "Asia/Shanghai"

STEALTH_JS = """
() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  try { Object.defineProperty(navigator, 'platform', { get: () => '__PLATFORM__' }); } catch(e){}
  try { Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => __HW__ }); } catch(e){}
  try { Object.defineProperty(navigator, 'deviceMemory', { get: () => __MEM__ }); } catch(e){}
  try { Object.defineProperty(navigator, 'languages', { get: () => __LANGS__ }); } catch(e){}
  try {
    const p = [
      {name:'Chrome PDF Plugin', description:'Portable Document Format', filename:'internal-pdf-viewer'},
      {name:'Chrome PDF Viewer', description:'', filename:'mhjfbmdgcfjbbgmofbbkfbkglfaoblio'},
      {name:'Native Client', description:'', filename:'ppapi'}
    ];
    Object.defineProperty(navigator, 'plugins', { get: () => p });
  } catch(e){}
  const getParam = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(p) {
    if (p === 37445) return 'Google Inc. (NVIDIA)';
    if (p === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
    if (p === 7938) return 'WebKit';
    return getParam.call(this, p);
  };
  try { window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} }; } catch(e){}
}
"""
STEALTH_JS = (STEALTH_JS
    .replace("__PLATFORM__", FAKE_PLATFORM)
    .replace("__HW__", str(FAKE_HW_CONCURRENCY))
    .replace("__MEM__", str(FAKE_DEVICE_MEMORY))
    .replace("__LANGS__", json.dumps(FAKE_LANG)))


async def solve_slider(page):
    for frame in page.frames:
        try:
            slider = await frame.wait_for_selector(
                ".nc_iconfont.btn_slide, .btn_slide, .sliding-card .btn_slide",
                timeout=2500,
            )
            if not slider:
                continue
            box = await slider.bounding_box()
            if not box:
                continue
            track = await frame.query_selector(".nc-lang-cnt, .nc_scale, .sliding-card")
            tbox = await track.bounding_box() if track else None
            distance = int((tbox["width"] - box["width"] - 12)) if tbox else 300
            x0 = box["x"] + box["width"] / 2
            y0 = box["y"] + box["height"] / 2
            await page.mouse.move(x0, y0)
            await page.mouse.down()
            steps = 30
            for i in range(1, steps + 1):
                t = i / steps
                ease = t * t * (3 - 2 * t)  # smoothstep
                jitter = (i % 3 - 1) * 1.5
                nx = x0 + distance * ease + jitter
                ny = y0 + (i % 2 - 0.5) * 1.2
                await page.mouse.move(nx, ny)
                await asyncio.sleep(0.02)
            await page.mouse.up()
            await asyncio.sleep(1.5)
            return True
        except Exception:
            continue
    return False


def resolve_chrome():
    """Prefer the real system Chrome (correct TLS/JA3) over bundled headless.
    On a laptop this is what makes Aliyun traceless pass. Falls back to
    the playwright-bundled chromium when no real Chrome is found."""
    env_path = os.environ.get("ZCODE_CHROME_PATH")
    if env_path and os.path.exists(env_path):
        return {"executable_path": env_path}
    # Playwright can drive the installed Chrome via channel="chrome"
    try:
        from playwright.async_api import chromium as _cr
        _cr.executable_path  # touch to ensure import ok
        return {"channel": "chrome"}
    except Exception:
        return {}


async def run(proxy=None):
    launch_args = ["--no-sandbox", "--disable-setuid-sandbox",
                   "--disable-blink-features=AutomationControlled"]
    chrome = resolve_chrome()
    browser = None
    result = {"success": False, "error": "unknown", "sdkLoaded": False,
               "chrome": "real" if (chrome.get("channel") or chrome.get("executable_path")) else "bundled"}
    try:
        async with async_playwright() as p:
            launch_kwargs = dict(
                headless=True,
                args=launch_args,
                proxy={"server": proxy} if proxy else None,
            )
            if chrome.get("executable_path"):
                launch_kwargs["executable_path"] = chrome["executable_path"]
            elif chrome.get("channel"):
                launch_kwargs["channel"] = chrome["channel"]
            else:
                launch_kwargs["executable_path"] = (
                    "/root/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome")
            browser = await p.chromium.launch(**launch_kwargs)
            context = await browser.new_context(
                user_agent=FAKE_UA,
                viewport={"width": 1920, "height": 1080},
                locale="en-US",
                timezone_id=FAKE_TZ,
                color_scheme="light",
                extra_http_headers={"Referer": "https://zcode.z.ai/"},
            )
            await context.add_init_script(STEALTH_JS)
            page = await context.new_page()
            errors = []
            page.on("console", lambda m: errors.append(f"CONSOLE:{m.type}:{m.text[:120]}") if m.type in ("error", "warning") else None)
            page.on("requestfailed", lambda r: errors.append(f"REQFAIL:{r.url[:60]}:{r.failure}"))

            await page.goto("https://zcode.z.ai/", wait_until="domcontentloaded", timeout=20000)
            # inject the config + SDK properly (innerHTML does NOT execute <script>)
            await page.evaluate("""
                window.AliyunCaptchaConfig = { region:'__RG__', prefix:'__PF__' };
            """.replace("__RG__", CAPTCHA_REGION).replace("__PF__", CAPTCHA_PREFIX))
            await page.add_script_tag(url=ALIYUN_SDK)
            await page.wait_for_function(
                "typeof initAliyunCaptcha !== 'undefined'", timeout=15000)
            await page.evaluate("""
                window.__ZC = { success:false, verifyParam:null, error:null, challenged:false, sdkLoaded:(typeof initAliyunCaptcha!=='undefined') };
                const done = (r) => { window.__ZC = Object.assign(window.__ZC, r); };
                try {
                  window.initAliyunCaptcha({
                    SceneId: '__SC__',
                    mode: 'popup',
                    element: '#captcha-element',
                    button: '#captcha-button',
                    getInstance: (inst) => { window._captchaInst = inst; if (inst.startTracelessVerification) inst.startTracelessVerification(); },
                    success: (verifyParam) => done({ success:true, verifyParam, region:'__RG__' }),
                    fail: (err) => { window.__ZC.challenged = true; if (window._captchaInst && window._captchaInst.show) window._captchaInst.show(); },
                    onError: (err) => done({ success:false, error:(err&&err.verifyCode)?err.verifyCode:String(err) }),
                  });
                } catch(e) { done({ success:false, error:String(e) }); }
            """.replace("__SC__", CAPTCHA_SCENE).replace("__RG__", CAPTCHA_REGION))

            for _ in range(45):
                zc = await page.evaluate("window.__ZC")
                if zc.get("success") or zc.get("error"):
                    result = zc
                    break
                if zc.get("challenged"):
                    await solve_slider(page)
                    zc = await page.evaluate("window.__ZC")
                    if zc.get("success") or zc.get("error"):
                        result = zc
                        break
                await asyncio.sleep(0.4)
            else:
                result = await page.evaluate("window.__ZC") or result
            result["_debug"] = errors[:8]
    except Exception as e:
        result = {"success": False, "error": str(e)[:200], "_debug": []}
    finally:
        if browser:
            try:
                await browser.close()
            except Exception:
                pass
    print(json.dumps(result))
    return result


def main():
    proxy = os.environ.get("ZCODE_CAPTCHA_PROXY") or None
    try:
        asyncio.run(asyncio.wait_for(run(proxy), timeout=100))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)[:200], "_debug": []}))


if __name__ == "__main__":
    main()
