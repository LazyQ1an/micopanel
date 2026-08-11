from pathlib import Path
import os

from playwright.sync_api import sync_playwright


ARTIFACTS = Path("artifacts")
ARTIFACTS.mkdir(exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(
        headless=True,
        executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    )
    page = browser.new_page(viewport={"width": 1440, "height": 960})
    errors = []
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)

    page.goto(os.environ.get("PANEL_URL", "http://127.0.0.1:5273"), wait_until="networkidle")
    page.get_by_label("用户名").fill("panel-admin")
    page.get_by_label("密码").fill("CorrectHorseBatteryStaple1!")
    page.get_by_role("button", name="创建并进入面板").click()
    page.get_by_role("heading", name="总览").wait_for()

    page.get_by_role("button", name="节点").click()
    page.get_by_role("button", name="添加节点").last.click()
    dialog = page.get_by_role("dialog", name="添加受管节点")
    dialog.get_by_label("节点名称").fill("hangzhou-01")
    dialog.get_by_role("button", name="生成注册令牌").click()
    dialog.get_by_text("仅显示一次的注册令牌").wait_for()
    assert len(dialog.locator("code").inner_text()) >= 30
    dialog.get_by_role("button", name="关闭").click()

    page.get_by_role("button", name="实例").click()
    page.get_by_role("button", name="创建", exact=True).click()
    dialog = page.get_by_role("dialog", name="创建 Minecraft 实例")
    dialog.get_by_label("实例名称").fill("survival-01")
    dialog.locator("select[name=kind]").select_option("custom")
    dialog.get_by_label("服务端包").wait_for()
    dialog.locator("select[name=kind]").select_option("paper")
    dialog.get_by_label("版本").fill("1.21.4")
    dialog.get_by_label("内存 MB").fill("2048")
    dialog.get_by_label("vCPU").fill("1")
    dialog.get_by_label("磁盘 MB").fill("10240")
    dialog.get_by_label("我已阅读并同意 Mojang EULA").check()
    dialog.get_by_role("button", name="创建实例").click()
    page.get_by_text("survival-01").first.wait_for()
    page.wait_for_timeout(450)
    assert page.locator(".instance-workspace").evaluate("element => getComputedStyle(element).opacity") == "1"
    page.screenshot(path=str(ARTIFACTS / "control-panel.png"), full_page=True)
    page.set_viewport_size({"width": 390, "height": 844})
    page.get_by_title("打开导航").click()
    page.get_by_role("button", name="节点").click()
    page.screenshot(path=str(ARTIFACTS / "control-panel-mobile.png"), full_page=True)

    assert not errors, f"Browser console errors: {errors}"
    browser.close()
