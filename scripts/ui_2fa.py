# -*- coding: utf-8 -*-
"""MicoPanel UI e2e: two-factor authentication + self-service password change."""
import sys, time, os, base64, hashlib, hmac, struct
from pathlib import Path
from playwright.sync_api import sync_playwright

EXE = r"C:\Users\Sedis\AppData\Local\ms-playwright\chromium-1234\chrome-win64\chrome.exe"
BASE = os.environ.get("PANEL_URL", "http://localhost:5173")
SHOTS = Path(__file__).resolve().parent.parent / "artifacts" / "e2e"
ADMIN = os.environ.get("PANEL_ADMIN", "admin")
ADMIN_PASSWORD = os.environ.get("PANEL_PASSWORD", "admin123456")
NEW_PASSWORD = "admin2fa-2026"
SHOTS.mkdir(parents=True, exist_ok=True)


def totp_code(secret, drift=0):
    counter = int(time.time() // 30) + drift
    key = base64.b32decode(secret.upper())
    msg = struct.pack(">Q", counter)
    digest = hmac.new(key, msg, hashlib.sha1).digest()
    o = digest[-1] & 0x0F
    code = ((digest[o] & 0x7F) << 24 | (digest[o + 1] << 16) | (digest[o + 2] << 8) | digest[o + 3]) % 10 ** 6
    return "%06d" % code


def wait_until(cond, timeout=10, interval=0.3):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if cond():
            return True
        time.sleep(interval)
    return False


def main():
    results = []
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=EXE, headless=True, args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        page.set_default_timeout(15000)
        page.on("pageerror", lambda e: errors.append("pageerror: %s" % e))
        page.on("console", lambda m: errors.append("console: %s" % m.text) if m.type == "error" else None)
        page.route("**fonts.googleapis.com/**", lambda route: route.abort())
        page.route("**fonts.gstatic.com/**", lambda route: route.abort())

        def check(name, cond):
            results.append((name, bool(cond)))

        def toast():
            try:
                loc = page.locator(".toast-stack .toast")
                loc.wait_for(state="visible", timeout=800)
                return loc.inner_text(timeout=400)
            except Exception:
                return ""

        def wait_toast(text, timeout=15):
            return wait_until(lambda: text in toast(), timeout=timeout, interval=0.2)

        def open_security():
            page.click('.sidebar-footer .icon-button[title="安全设置"]')
            page.wait_for_selector(".security-dialog", timeout=10000)

        # ---- login as admin ----
        page.goto(BASE)
        page.wait_for_selector("form.auth-form", timeout=20000)
        page.fill('input[name="username"]', ADMIN)
        page.fill('input[name="password"]', ADMIN_PASSWORD)
        page.click('button[type="submit"]')
        page.wait_for_selector(".page-content", timeout=20000)
        check("admin login", page.locator(".sidebar-footer .user-chip strong").inner_text() == ADMIN)

        # ---- change password (wrong current first) ----
        open_security()
        page.fill('input[name="currentPassword"]', "wrong-password-1")
        page.fill('input[name="newPassword"]', NEW_PASSWORD)
        page.fill('input[name="confirmPassword"]', NEW_PASSWORD)
        page.click('.security-form button:has-text("更新密码")')
        check("wrong current rejected", wait_toast("当前密码不正确"))
        page.fill('input[name="currentPassword"]', ADMIN_PASSWORD)
        page.click('.security-form button:has-text("更新密码")')
        check("password changed", wait_toast("密码已更新"))
        page.screenshot(path=str(SHOTS / "security-password.png"))

        # ---- enable 2FA ----
        page.click('button:has-text("开启两步验证")')
        page.wait_for_selector(".totp-qr", timeout=10000)
        secret = page.locator(".totp-secret").inner_text().strip()
        check("qr + secret rendered", len(secret) >= 16)
        page.screenshot(path=str(SHOTS / "2fa-provision.png"))
        page.fill('.totp-setup input[name="code"]', totp_code(secret))
        page.click('.totp-setup button:has-text("验证并开启")')
        page.wait_for_selector(".recovery-grid", timeout=10000)
        recovery = page.locator(".recovery-grid code").all_inner_texts()
        check("recovery codes shown", len(recovery) == 10)
        check("2fa enabled toast", wait_toast("两步验证已开启"))
        page.screenshot(path=str(SHOTS / "2fa-recovery.png"))
        page.click(".security-dialog .dialog-head .icon-button")

        # ---- logout, login now demands the second factor ----
        page.click('.sidebar-footer .icon-button[title="退出登录"]')
        page.wait_for_selector("form.auth-form", timeout=15000)
        page.fill('input[name="username"]', ADMIN)
        page.fill('input[name="password"]', NEW_PASSWORD)
        page.click('button[type="submit"]')
        page.wait_for_selector('form.auth-form:has-text("两步验证码")', timeout=15000)
        check("2fa challenge shown", True)
        page.screenshot(path=str(SHOTS / "2fa-challenge.png"))

        # wrong code rejected
        page.fill('input[name="code"]', "000000")
        page.click('form.auth-form button[type="submit"]')
        check("wrong code rejected", wait_until(lambda: "两步验证码不正确" in page.locator(".form-error").inner_text() if page.locator(".form-error").count() else False))

        # recovery code works
        page.fill('input[name="code"]', recovery[0].strip())
        page.click('form.auth-form button[type="submit"]')
        page.wait_for_selector(".page-content", timeout=20000)
        check("recovery code login", True)

        # the same recovery code is now spent
        page.click('.sidebar-footer .icon-button[title="退出登录"]')
        page.wait_for_selector("form.auth-form", timeout=15000)
        page.fill('input[name="username"]', ADMIN)
        page.fill('input[name="password"]', NEW_PASSWORD)
        page.click('button[type="submit"]')
        page.wait_for_selector('form.auth-form:has-text("两步验证码")', timeout=15000)
        page.fill('input[name="code"]', recovery[0].strip())
        page.click('form.auth-form button[type="submit"]')
        check("spent recovery code rejected", wait_until(lambda: "两步验证码不正确" in page.locator(".form-error").inner_text() if page.locator(".form-error").count() else False))

        # totp login works
        page.fill('input[name="code"]', totp_code(secret))
        page.click('form.auth-form button[type="submit"]')
        page.wait_for_selector(".page-content", timeout=20000)
        check("totp login", True)

        # ---- disable 2FA ----
        open_security()
        check("2fa status on", wait_until(lambda: "已开启" in page.locator(".security-state.on").inner_text() if page.locator(".security-state.on").count() else False))
        page.fill(".totp-enabled input", totp_code(secret))
        page.click('.totp-enabled button:has-text("关闭两步验证")')
        check("2fa disabled", wait_toast("两步验证已关闭"))
        check("2fa status off", wait_until(lambda: "未开启" in page.locator(".security-state.off").inner_text() if page.locator(".security-state.off").count() else False))

        # ---- restore the original password ----
        page.fill('input[name="currentPassword"]', NEW_PASSWORD)
        page.fill('input[name="newPassword"]', ADMIN_PASSWORD)
        page.fill('input[name="confirmPassword"]', ADMIN_PASSWORD)
        page.click('.security-form button:has-text("更新密码")')
        check("password restored", wait_toast("密码已更新"))
        page.click(".security-dialog .dialog-head .icon-button")

        # ---- login with original password, no 2FA ----
        page.click('.sidebar-footer .icon-button[title="退出登录"]')
        page.wait_for_selector("form.auth-form", timeout=15000)
        page.fill('input[name="username"]', ADMIN)
        page.fill('input[name="password"]', ADMIN_PASSWORD)
        page.click('button[type="submit"]')
        page.wait_for_selector(".page-content", timeout=20000)
        check("plain login after disable", True)
        page.screenshot(path=str(SHOTS / "2fa-final.png"))

        browser.close()

    print("=== RESULTS ===")
    ok = True
    for name, passed in results:
        print(("PASS" if passed else "FAIL"), name)
        ok = ok and passed
    print("=== ERRORS ===")
    for e in errors[:20]:
        print("ERR", e)
    print("OVERALL:", "OK" if ok else "FAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
