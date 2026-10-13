"""Synthetic-host smoke checks for the adopted HAYAKU mockup shell.

The repository host fixture blocks network and model calls. This test does not
load user data or invoke any destructive/model action.
"""
from pathlib import Path
import os
import shutil
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[3]
HOST = ROOT / "PROGRAM/tests/browser/hayaku_browser_host.js"
SOURCE = ROOT / "PROGRAM/plugins/HAYAKU_Locator_Continuity.js"


def main():
    browser_exe = os.environ.get("CHROMIUM_PATH") or shutil.which("chromium") or shutil.which("chromium-browser")
    if not browser_exe:
        raise SystemExit("CHROMIUM_PATH or chromium is required")
    host = HOST.read_text(encoding="utf-8")
    source = SOURCE.read_text(encoding="utf-8")
    hook = "  await install();"
    assert source.count(hook) == 1
    source = source.replace(hook, "  globalThis.__hayakuGuiSmoke={viewerSetTab,viewerRenderOperationLog,Memory,HAYAKU_GUI_SETTING_SPECS};\n" + hook)
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=browser_exe, headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        page.set_default_timeout(5000)
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.set_content("<!doctype html><html lang='ko'><meta charset='utf-8'><body></body></html>")
        page.add_script_tag(content=host)
        page.add_script_tag(content=source)
        page.wait_for_function("!!window.HAYAKU", timeout=30000)
        page.evaluate("HAYAKU.showUi()")
        page.wait_for_selector('.app[data-hayaku-mockup="1"]')
        page.wait_for_timeout(250)
        duplicate_ids = page.evaluate("(() => { const ids=[...document.querySelectorAll('[id]')].map(node=>node.id); return ids.filter((id,index)=>ids.indexOf(id)!==index); })()")
        assert not duplicate_ids, duplicate_ids

        destinations = ["overview", "packets", "recovery", "server", "settings", "logs"]
        for destination in destinations:
            page.evaluate("name => __hayakuGuiSmoke.viewerSetTab(name)", destination)
            assert page.locator(f'[data-hayaku-viewer-panel="{destination}"]').is_visible(), destination
        assert page.locator('#hayakuViewerPanelPackets .page-head .page-actions .seg [data-packet-view]').count() == 2
        assert page.locator('#hayakuViewerPanelPackets .pk-layout[data-detail-root] #hayakuViewerRecords.pk-list').count() == 1
        assert page.locator('#hayakuViewerPanelPackets #hayakuViewerRecordDetail.card').count() == 1
        assert page.locator('#hayakuViewerPanelRecovery .tabs[data-subtabs="rc"] [role=tab]').count() == 4
        assert page.locator('#hayakuViewerPanelRecovery [data-subpanel="miss"] .steps .step').count() == 4
        assert page.locator('#hayakuViewerPanelRecovery [data-subpanel="miss"] .cost-table dt').count() == 6
        assert page.locator('#hayakuViewerPanelRecovery #hayakuFailedRecoveryDetail [data-subtabs="hayakuFailureDetail"] [role=tab]').count() == 5
        assert page.locator('#hayakuViewerPanelRecovery #hayakuFailedRecoverySource').evaluate("node => node.tagName") == "PRE"
        assert page.locator('#hayakuViewerPanelRecovery #hayakuFailedRecoveryRaw').evaluate("node => node.tagName") == "PRE"
        assert page.locator('#hayakuViewerPanelRecovery #hayakuFailedRecoveryGroundingStatus').evaluate("node => node.tagName") == "PRE"
        assert page.locator('#hayakuViewerPanelRecovery #hayakuFailedRecoveryPreview').evaluate("node => node.tagName") == "PRE"
        assert page.locator('#hayakuViewerPanelRecovery #hayakuFailedRecoveryEditor').is_hidden()
        assert page.locator('#hayakuViewerPanelRecovery [data-portable-backup-host="hayaku_locator_continuity"]').count() == 1
        assert page.locator('#hayakuViewerPanelServer .grid.g2 #hayakuMemorySuiteServerConnectionPanel.card').count() == 1
        assert page.locator('#hayakuViewerPanelLogs .page-head .page-actions button').count() == 2
        assert page.locator('#hayakuViewerPanelLogs .search #hayakuLogFilter.input').count() == 1
        assert page.locator('#hayakuViewerPanelLogs #hayakuViewerOperationLog.list').count() == 1
        page.evaluate("""()=>{__hayakuGuiSmoke.Memory.operationLog=[{level:'info',event:'synthetic_log_test',at:Date.now(),detail:{fixture:true}}];__hayakuGuiSmoke.viewerRenderOperationLog();}""")
        assert page.locator('#hayakuViewerOperationLog > .row').count() == 1
        assert page.locator('#hayakuViewerOperationLog .rec').count() == 0
        page.locator('#hayakuLogFilter').fill('no-match')
        assert page.locator('#hayakuViewerOperationLog > .row').is_hidden()
        page.locator('#hayakuLogFilter').fill('synthetic_log_test')
        assert page.locator('#hayakuViewerOperationLog > .row').is_visible()
        page.locator('#hayakuLogFilter').fill('')

        page.evaluate("__hayakuGuiSmoke.viewerSetTab('packets')")
        page.locator('[data-packet-view="worldline"]').click()
        assert page.locator("#hayakuPacketWorldlineView").is_visible()
        page.locator('[data-packet-view="list"]').click()
        assert page.locator("#hayakuPacketListView").is_visible()

        page.evaluate("__hayakuGuiSmoke.viewerSetTab('recovery')")
        for panel in ["missing", "reanalysis", "failed", "cold"]:
            page.locator(f'[data-recovery-view="{panel}"]').click()
            assert page.locator(f'[data-recovery-panel="{panel}"]').is_visible(), panel
        page.locator('#hayakuViewerPanelRecovery [data-recovery-view="failed"]').click()
        detail_tabs = page.locator('#hayakuFailedRecoveryDetail [data-subtabs="hayakuFailureDetail"] [data-subtab]')
        page.locator('#hayakuFailedRecoveryDetail').evaluate("node => node.hidden = false")
        detail_tabs.nth(1).click()
        assert page.locator('#hayakuFailedRecoveryRaw').is_visible()
        assert detail_tabs.nth(1).get_attribute('aria-selected') == 'true'

        page.evaluate("__hayakuGuiSmoke.viewerSetTab('settings')")
        page.wait_for_timeout(100)
        assert page.locator('#hayakuViewerPanelSettings .st-nav').count() == 1
        assert page.locator('#hayakuViewerPanelSettings .st-nav [role=tab]').count() == 4
        assert page.locator('#hayakuSettingsForm [data-subpanel][data-group="st"]').count() == 4
        assert page.locator('#hayakuSettingsForm .setting:has(.argtag)').count() == 43
        assert page.locator('#hayakuSettingsForm .setting .switch').count() == 19
        assert page.locator('#hayakuSettingsForm [data-load-defaults="[data-subpanel]"]').count() == 4
        section_names = page.locator('#hayakuViewerPanelSettings .st-nav [data-subtab]').evaluate_all("nodes => nodes.map(node => node.dataset.subtab)")
        assert section_names == ["basic", "pick", "safe", "adv"], section_names
        for section in section_names:
            page.locator(f'#hayakuViewerPanelSettings .st-nav [data-subtab="{section}"]').click()
            assert page.locator(f'#hayakuViewerPanelSettings .st-nav [data-subtab="{section}"]').get_attribute('aria-selected') == 'true'
            assert page.locator(f'[data-subpanel="{section}"]').evaluate("node => node.classList.contains('is-active')")
        page.locator('#hayakuViewerPanelSettings .st-nav [data-subtab="basic"]').click()
        page.locator('[data-hayaku-mode-value="fast"]').click()
        assert page.locator('[data-hayaku-mode-value="fast"]').get_attribute('aria-pressed') == 'true'
        assert page.locator('#hayakuSettingsSavebar').is_visible()
        page.locator('#cancelHayakuSettings').click()
        assert page.locator("#hayakuSettingsForm [name]").count() == page.evaluate("__hayakuGuiSmoke.HAYAKU_GUI_SETTING_SPECS.length")
        fields = page.locator("#hayakuSettingsForm [name]").evaluate_all("nodes => nodes.map(node => node.name).sort()")
        schema_fields = page.evaluate("__hayakuGuiSmoke.HAYAKU_GUI_SETTING_SPECS.map(spec => spec.argument).sort()")
        assert fields == schema_fields, {"mounted": fields, "schema": schema_fields}
        assert not errors, errors
        calls = page.evaluate("__hostCalls")
        assert calls["llm"] == 0 and calls["network"] == 0, calls
        print({"destinations": destinations, "packetViews": 2, "recoveryViews": 4,
               "settingsFields": page.evaluate("__hayakuGuiSmoke.HAYAKU_GUI_SETTING_SPECS.length"),
               "pageErrors": errors, "hostCalls": calls})
        browser.close()


if __name__ == "__main__":
    main()
