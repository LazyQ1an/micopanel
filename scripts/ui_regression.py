# -*- coding: utf-8 -*-
"""MicoPanel UI regression: users management, node delete, instance archive/restore."""
import sys, time, os
from pathlib import Path
from playwright.sync_api import sync_playwright

EXE = r"C:\Users\Sedis\AppData\Local\ms-playwright\chromium-1234\chrome-win64\chrome.exe"
BASE = os.environ.get("PANEL_URL", "http://localhost:5173")
SHOTS = Path(__file__).resolve().parent.parent / "artifacts" / "e2e"
SUFFIX = str(int(time.time()) % 100000)
ADMIN = os.environ.get("PANEL_ADMIN", "admin")
ADMIN_PASSWORD = os.environ.get("PANEL_PASSWORD", "admin123456")
SHOTS.mkdir(parents=True, exist_ok=True)

def login(page, username, password):
    page.goto(BASE)
    page.wait_for_selector("form.auth-form", timeout=20000)
    page.fill('input[name="username"]', username)
    page.fill('input[name="password"]', password)
    page.click('button[type="submit"]')
    page.wait_for_selector(".page-content", timeout=20000)

def go(page, label):
    page.click(f'nav .nav-item:has-text("{label}")')
    page.wait_for_selector(".page-content", timeout=15000)

def toast_text(page):
    try:
        return page.locator(".toast-stack .toast").inner_text(timeout=6000)
    except Exception:
        return ""

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
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.on("console", lambda m: errors.append(f"console: {m.text}") if m.type == "error" else None)
        page.route("**fonts.googleapis.com/**", lambda route: route.abort())
        page.route("**fonts.gstatic.com/**", lambda route: route.abort())

        def check(name, cond):
            results.append((name, bool(cond)))

        # ---- 1. admin login ----
        login(page, ADMIN, ADMIN_PASSWORD)
        check("admin login", page.locator(".sidebar-footer .user-chip strong").inner_text() == "admin")

        # ---- 2. users page ----
        go(page, "用户")
        page.wait_for_selector(".user-create-form", timeout=15000)
        check("users page rendered", page.locator(".user-create-form").count() == 1)
        page.screenshot(path=str(SHOTS / "users-empty.png"))

        # create user
        page.fill('.user-create-form input[name="username"]', "builder-" + SUFFIX)
        page.fill('.user-create-form input[name="password"]', "builderpass123")
        page.click('.user-create-form button[type="submit"]')
        page.wait_for_selector(f'.user-row:has-text("builder-{SUFFIX}")', timeout=15000)
        check("create user row", page.locator(f'.user-row:has-text("builder-{SUFFIX}")').count() == 1)
        check("create toast", "账号已创建" in toast_text(page))

        # role change to admin and back to user
        row = page.locator(f'.user-row:has-text("builder-{SUFFIX}")')
        row.locator(".user-role-select").select_option("admin")
        row = page.locator(f'.user-row:has-text("builder-{SUFFIX}")')
        check("role -> admin", wait_until(lambda: row.locator(".user-role-select").input_value() == "admin"))
        row.locator(".user-role-select").select_option("user")
        row = page.locator(f'.user-row:has-text("builder-{SUFFIX}")')
        check("role -> user", wait_until(lambda: row.locator(".user-role-select").input_value() == "user"))

        # reset password
        row.locator('.icon-button[title="重置密码"]').click()
        row.locator(".user-password-input").fill("newpass12345")
        row.locator('.user-actions .button:has-text("确认")').click()
        row = page.locator(f'.user-row:has-text("builder-{SUFFIX}")')
        check("reset password", wait_until(lambda: row.locator(".user-password-input").count() == 0))
        check(
            "reset password toast",
            wait_until(lambda: "已重置" in page.locator(".toast-stack .toast").inner_text() if page.locator(".toast-stack .toast").count() else False),
        )

        # delete user
        row.locator('.icon-button[title="删除账号"]').click()
        page.wait_for_selector(".confirm-dialog", timeout=10000)
        page.click(".confirm-dialog button.danger")
        page.wait_for_selector('.toast-stack .toast:has-text("已删除")', timeout=10000)
        page.wait_for_selector(f'.user-row:has-text("builder-{SUFFIX}")', state="detached", timeout=10000)
        check("delete user", True)
        page.screenshot(path=str(SHOTS / "users-after-delete.png"))

        # ---- 3. node create + delete ----
        go(page, "节点")
        page.wait_for_selector(".nodes-panel", timeout=15000)
        page.click('.nodes-panel .panel-heading button:has-text("添加节点")')
        page.wait_for_selector("form.dialog-form", timeout=10000)
        page.fill('form.dialog-form input[name="name"]', "test-node-" + SUFFIX)
        page.click('form.dialog-form button[type="submit"]')
        page.wait_for_selector(".enrollment", timeout=15000)
        page.screenshot(path=str(SHOTS / "node-enrollment.png"))
        page.click(".dialog-head .icon-button")
        page.wait_for_selector(".node-card", timeout=15000)
        check("node card rendered", page.locator(".node-card").count() == 1)

        # cancel first
        page.click(".node-delete-trigger")
        page.wait_for_selector(".confirm-dialog", timeout=10000)
        page.click('.confirm-dialog button:has-text("取消")')
        page.wait_for_selector(".confirm-dialog", state="detached", timeout=10000)
        check("cancel node delete", page.locator(".node-card").count() == 1)

        # delete for real
        page.click(".node-delete-trigger")
        page.wait_for_selector(".confirm-dialog", timeout=10000)
        page.click(".confirm-dialog button.danger")
        page.wait_for_selector('.toast-stack .toast:has-text("已删除")', timeout=10000)
        page.wait_for_selector(".node-card", state="detached", timeout=15000)
        check("node deleted", True)

        # ---- 4. instance archive/restore ----
        # create a node first
        page.click('.nodes-panel .panel-heading button:has-text("添加节点")')
        page.wait_for_selector("form.dialog-form", timeout=10000)
        page.fill('form.dialog-form input[name="name"]', "instance-node-" + SUFFIX)
        page.click('form.dialog-form button[type="submit"]')
        page.wait_for_selector(".enrollment", timeout=15000)
        page.click(".dialog-head .icon-button")
        page.wait_for_selector(".node-card", timeout=15000)

        go(page, "实例")
        page.wait_for_selector(".table-panel", timeout=15000)
        page.click('.filters button:has-text("创建")')
        page.wait_for_selector("form.dialog-form", timeout=10000)
        page.fill('form.dialog-form input[name="name"]', "survival-" + SUFFIX)
        page.check('form.dialog-form input[name="eula"]')
        page.click('form.dialog-form button:has-text("创建实例")')
        page.wait_for_selector(f'.instance-row:has-text("survival-{SUFFIX}")', timeout=20000)
        check("instance created", True)

        # open instance workspace
        page.click(f'.instance-row:has-text("survival-{SUFFIX}")')
        page.wait_for_selector(".instance-workspace", timeout=15000)
        page.screenshot(path=str(SHOTS / "workspace.png"))
        check("archive button present", page.locator('.power-controls .icon-button[title="归档实例"]').count() == 1)

        # archive
        page.click('.power-controls .icon-button[title="归档实例"]')
        page.wait_for_selector(".confirm-dialog", timeout=10000)
        page.screenshot(path=str(SHOTS / "archive-confirm.png"))
        page.click(".confirm-dialog button.danger")
        page.wait_for_selector(".archived-banner", timeout=20000)
        check("archived banner", page.locator(".archived-banner").count() == 1)
        check("restore button present", page.locator('.power-controls .icon-button[title="恢复实例"]').count() == 1)
        page.screenshot(path=str(SHOTS / "archived.png"))

        # restore
        page.click('.archived-banner button:has-text("立即恢复")')
        page.wait_for_selector(".archived-banner", state="detached", timeout=20000)
        check("restored", True)

        # ---- 5. non-admin nav filtering ----
        go(page, "用户")
        page.wait_for_selector(".user-create-form", timeout=15000)
        page.fill('.user-create-form input[name="username"]', "viewer-" + SUFFIX)
        page.fill('.user-create-form input[name="password"]', "viewerpass123")
        page.click('.user-create-form button[type="submit"]')
        page.wait_for_selector(f'.user-row:has-text("viewer-{SUFFIX}")', timeout=15000)

        page.click('.sidebar-footer .icon-button[title="退出登录"]')
        page.wait_for_selector("form.auth-form", timeout=15000)
        login(page, "viewer-" + SUFFIX, "viewerpass123")
        page.wait_for_selector("nav .nav-item", timeout=15000)
        nav_texts = page.locator("nav .nav-item").all_inner_texts()
        check("admin-only nav hidden for user", not any("用户" in t for t in nav_texts))
        page.screenshot(path=str(SHOTS / "viewer-nav.png"))

        page.click('.sidebar-footer .icon-button[title="退出登录"]')
        page.wait_for_selector("form.auth-form", timeout=15000)
        login(page, ADMIN, ADMIN_PASSWORD)
        go(page, "用户")
        page.wait_for_selector(f'.user-row:has-text("viewer-{SUFFIX}")', timeout=15000)
        page.locator(f'.user-row:has-text("viewer-{SUFFIX}") .icon-button[title="删除账号"]').click()
        page.wait_for_selector(".confirm-dialog", timeout=10000)
        page.click(".confirm-dialog button.danger")
        page.wait_for_selector(f'.user-row:has-text("viewer-{SUFFIX}")', state="detached", timeout=10000)
        check("cleanup viewer", True)

        browser.close()

    print("=== RESULTS ===")
    ok = True
    for name, passed in results:
        print(("PASS" if passed else "FAIL"), name)
        ok = ok and passed
    print("=== CONSOLE/PAGE ERRORS ===")
    for e in errors[:20]:
        print("ERR", e)
    print("OVERALL:", "OK" if ok else "FAILED")
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
