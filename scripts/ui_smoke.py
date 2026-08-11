from pathlib import Path
import os
from time import sleep

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
    failed_responses = []
    failed_requests = []
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    page.on("response", lambda response: failed_responses.append(f"{response.status} {response.url}") if response.status >= 400 else None)
    page.on("requestfailed", lambda request: failed_requests.append(f"{request.failure} {request.url}"))

    panel_url = os.environ.get("PANEL_URL", "http://127.0.0.1:5173")
    for attempt in range(30):
        try:
            page.goto(panel_url, wait_until="networkidle")
            break
        except Exception:
            if attempt == 29:
                raise
            sleep(0.5)
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
    page.get_by_role("button", name="文件", exact=True).click()
    page.locator(".file-manager").wait_for()
    assert page.get_by_title("上传到当前目录").is_visible()
    assert page.get_by_title("刷新文件").is_visible()
    page.locator(".toast").click()
    page.get_by_role("button", name="协作者", exact=True).click()
    page.locator(".member-tool").wait_for()
    assert page.get_by_text("实例所有者", exact=False).is_visible()
    page.screenshot(path=str(ARTIFACTS / "control-panel-members.png"), full_page=True)
    page.get_by_role("button", name="配置", exact=True).click()
    page.locator(".config-tool").wait_for()
    assert page.get_by_text("保存会保留实例数据目录", exact=False).is_visible()
    page.get_by_role("button", name="添加变量", exact=True).click()
    page.get_by_label("环境变量名称").fill("MOTD")
    page.get_by_label("环境变量值").fill("Smoke checked")
    page.get_by_label("我确认保存后会重建运行容器").check()
    page.get_by_role("button", name="保存并重建", exact=True).click()
    page.get_by_text("配置重建任务已提交", exact=False).wait_for()
    page.screenshot(path=str(ARTIFACTS / "control-panel-config.png"), full_page=True)
    page.get_by_role("button", name="计划任务", exact=True).click()
    schedule_tool = page.locator(".schedule-manager")
    schedule_tool.wait_for()
    schedule_form = schedule_tool.locator(".schedule-form")
    schedule_form.locator("input").nth(0).fill("nightly-s3-smoke")
    schedule_form.locator("input").nth(1).fill("0 4 * * *")
    schedule_form.locator("select").nth(1).select_option("s3")
    schedule_form.get_by_role("button", name="添加计划任务").click()
    page.get_by_text("nightly-s3-smoke", exact=True).wait_for()
    schedule_row = page.locator(".schedule-manager-row", has_text="nightly-s3-smoke")
    schedule_row.get_by_title("编辑计划任务").click()
    schedule_form.locator("input").nth(0).fill("nightly-s3-smoke-edited")
    schedule_form.get_by_role("button", name="保存计划任务").click()
    page.get_by_text("nightly-s3-smoke-edited", exact=True).wait_for()
    schedule_row = page.locator(".schedule-manager-row", has_text="nightly-s3-smoke-edited")
    schedule_row.get_by_title("暂停计划任务").click()
    schedule_row.get_by_text("已暂停", exact=True).wait_for()
    page.screenshot(path=str(ARTIFACTS / "control-panel-schedules.png"), full_page=True)
    page.get_by_role("button", name="文件", exact=True).click()
    page.locator(".toast").click()
    page.screenshot(path=str(ARTIFACTS / "control-panel.png"), full_page=True)
    page.set_viewport_size({"width": 390, "height": 844})
    page.locator(".file-manager").wait_for()
    page.screenshot(path=str(ARTIFACTS / "control-panel-files-mobile.png"), full_page=True)
    page.get_by_role("button", name="协作者", exact=True).click()
    page.locator(".member-tool").wait_for()
    page.screenshot(path=str(ARTIFACTS / "control-panel-members-mobile.png"), full_page=True)
    page.get_by_role("button", name="配置", exact=True).click()
    page.locator(".config-tool").wait_for()
    page.screenshot(path=str(ARTIFACTS / "control-panel-config-mobile.png"), full_page=True)
    page.get_by_role("button", name="计划任务", exact=True).click()
    page.locator(".schedule-manager").wait_for()
    page.screenshot(path=str(ARTIFACTS / "control-panel-schedules-mobile.png"), full_page=True)
    page.get_by_title("打开导航").click()
    page.get_by_role("button", name="节点").click()
    page.screenshot(path=str(ARTIFACTS / "control-panel-mobile.png"), full_page=True)

    assert not errors, f"Browser console errors: {errors}; failed responses: {failed_responses}; failed requests: {failed_requests}"
    browser.close()
