"""HAYAKU narrow-header and canonical bottom navigation regression.

Uses the shipped plugin source in Chromium with the existing synthetic Risu
boundary. It never calls a model or accesses user data.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import hashlib, json, os, shutil

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(os.environ.get("HAYAKU_HEADER_EVIDENCE", "/tmp/hayaku-header-responsive"))
OUT.mkdir(parents=True, exist_ok=True)
source_path = Path(os.environ.get("HAYAKU_HEADER_SOURCE", ROOT / "plugins" / "HAYAKU_Locator_Continuity.js"))
source_bytes = source_path.read_bytes()
source = source_bytes.decode("utf-8")
anchor = "  await install();"
assert source.count(anchor) == 1
source = source.replace(anchor, "  globalThis.__headerTest = {Memory};\n" + anchor)
host = (ROOT / "tests" / "browser" / "hayaku_browser_host.js").read_text()
results = []
errors = []
failure = None

def check(name, ok, detail=None):
    results.append({"name": name, "ok": bool(ok), "detail": detail})
    if not ok:
        raise AssertionError(f"{name}: {detail}")

def metrics(page):
    return page.evaluate("""()=>{
      const q=s=>document.querySelector(s), box=n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
      const app=q('.app'),top=q('.topbar'),brand=q('.brand'),name=q('.brand__name'),ver=q('.brand__ver'),health=q('.health'),job=q('#hayakuNativeJobChip'),menu=q('.menu');
      const nodes=[brand,health,job,menu].map(box);
      return {viewport:innerWidth,appWidth:app.getBoundingClientRect().width,app:box(app),top:box(top),brand:box(brand),name:box(name),ver:box(ver),health:box(health),job:box(job),menu:box(menu),
        text:{brand:name.textContent,health:health.innerText,job:job.innerText,jobLabel:job.getAttribute('aria-label')},
        visible:{sidebar:getComputedStyle(q('.sidebar')).display,tabbar:getComputedStyle(q('.tabbar')).display,brandName:getComputedStyle(name).display,version:getComputedStyle(ver).display,jobLabel:getComputedStyle(job.querySelector('[data-tray-text]')).display},
        overflow:{document:document.documentElement.scrollWidth>innerWidth,app:app.scrollWidth>app.clientWidth,top:top.scrollWidth>top.clientWidth},
        intersections:nodes.slice(1).map((n,i)=>n.x<nodes[i].right-.5),brandInTop:brand.getBoundingClientRect().top>=top.getBoundingClientRect().top-1&&brand.getBoundingClientRect().bottom<=top.getBoundingClientRect().bottom+1,
        titleAccessible:name.textContent.trim()==='HAYAKU'&&!name.hasAttribute('aria-hidden'),trayVisible:!job.hidden};
    }""")

try:
    with sync_playwright() as p:
        executable = os.environ.get("CHROMIUM_PATH") or shutil.which("chromium") or shutil.which("chromium-browser")
        browser = p.chromium.launch(**({"executable_path": executable} if executable else {}), headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        page = browser.new_page(viewport={"width": 390, "height": 844})
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.set_content('<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"></body></html>')
        page.add_script_tag(content=host)
        page.add_script_tag(content=source)
        page.wait_for_function("!!window.HAYAKU")
        page.evaluate("HAYAKU.showUi()")
        page.wait_for_function("!!document.querySelector('.app') && !__headerTest.Memory.ledgerViewer.busy")

        for width, height in [(320,844),(360,844),(375,844),(390,844),(414,844),(640,844),(641,844),(900,844),(901,844)]:
            page.set_viewport_size({"width": width, "height": height})
            page.locator('.frame').evaluate('(node)=>node.style.removeProperty("width")')
            page.wait_for_timeout(20)
            m = metrics(page)
            if width in [320,390,414]:
                page.mouse.move(0,0)
                page.screenshot(path=str(OUT/f"header-{width}x{height}.png"))
            assert m["brandInTop"], f"viewport {width}: brand is vertically clipped: {m}"
            assert not any(m["intersections"]), f"viewport {width}: header actions overlap: {m}"
            assert not any(m["overflow"].values()), f"viewport {width}: horizontal overflow: {m}"
            assert m["titleAccessible"] and m["trayVisible"], f"viewport {width}: brand/task tray absent: {m}"
            assert m["health"]["width"] > 0 and m["health"]["height"] <= m["top"]["height"], f"viewport {width}: health status clipped: {m}"
            assert m["health"]["x"] >= m["top"]["x"] and m["menu"]["right"] <= m["top"]["right"], f"viewport {width}: header controls outside bar: {m}"
            if width <= 414:
                assert m["visible"]["version"] == "none", f"viewport {width}: long version label should be omitted in narrow header"
            if m["appWidth"] <= 300:
                assert m["visible"]["brandName"] == "block" and m["name"]["width"] <= 1, f"viewport {width}: brand should use accessible visually-hidden name: {m}"
            else:
                assert m["name"]["width"] > 1 and m["name"]["height"] < 30, f"viewport {width}: HAYAKU title must remain a single visible line: {m}"
            if m["appWidth"] <= 350:
                assert m["visible"]["jobLabel"] == "block" and m["job"]["width"] < 60, f"viewport {width}: compact tray label should remain accessibly named: {m}"
                assert m["text"]["jobLabel"], f"viewport {width}: icon-only tray needs an accessible label"
            else:
                assert m["job"]["width"] > 60, f"viewport {width}: task tray label should remain visible when it fits: {m}"
            if width <= 900:
                assert m["visible"]["sidebar"] == "none" and m["visible"]["tabbar"] == "grid", f"viewport {width}: original responsive navigation must use the bottom bar"
                bar = page.locator('.tabbar')
                assert bar.locator('> button').count() == 5, f"viewport {width}: four primary tabs plus More expected"
                assert bar.locator('[data-go]').count() == 4
                assert bar.locator('[data-hayaku-more]').count() == 1
                assert [x.strip() for x in bar.locator('button').all_inner_texts()] == ['관제','패킷','복구','연결','더보기']
                assert all(bar.locator('button').nth(i).locator('svg.ic').count()==1 for i in range(5))
            check(f"viewport-{width}: no header overlap/clipping and canonical navigation", True, m)

        # Exact application-container thresholds, independent of viewport stage padding.
        page.set_viewport_size({"width":1440,"height":1000})
        for frame_width, expected in [(640,"grid"),(641,"grid"),(900,"grid"),(901,"none")]:
            page.locator('.frame').evaluate('(node,w)=>node.style.width=w+"px"',frame_width)
            page.wait_for_timeout(30)
            m=metrics(page)
            assert not any(m["intersections"]) and not any(m["overflow"].values()) and m["brandInTop"], f"frame {frame_width}: header geometry {m}"
            assert m["visible"]["tabbar"]==expected, f"frame {frame_width}: original 900px tabbar breakpoint expected {expected}, got {m['visible']['tabbar']}"
            check(f"frame-{frame_width}: 640/900 container breakpoint and header fit",True,m)

        page.set_viewport_size({"width":390,"height":844})
        page.locator('.frame').evaluate('(node)=>node.style.removeProperty("width")')
        page.locator('[data-hayaku-more]').click()
        sheet=page.locator('#hayakuMoreSheet')
        assert sheet.get_attribute('aria-hidden')=='false' and sheet.locator('[data-more-list] .row').count()==2
        assert [t.strip() for t in sheet.locator('.row__title').all_inner_texts()]==['설정','작동 기록']
        assert sheet.locator('[data-more-list] .row svg.ic--sm.faint').count()==2
        check("More sheet exposes exact remaining two routes",True,{"rows":sheet.locator('.row__title').all_inner_texts(),"arrowCount":sheet.locator('[data-more-list] .row svg.ic--sm.faint').count()})
        page.keyboard.press('Escape')
        assert sheet.get_attribute('aria-hidden')=='true' and page.locator('[data-hayaku-more]').evaluate('(n)=>n===document.activeElement')
        check("Escape closes More and restores focus",True)
        page.locator('[data-hayaku-more]').click()
        sheet.locator('[data-hayaku-viewer-goto="settings"]').click()
        assert page.evaluate('__headerTest.Memory.ledgerViewer.activeTab')=='settings'
        assert page.locator('.tabbar [data-go="settings"]').count()==0
        assert page.locator('#hayakuMoreSheet').get_attribute('aria-hidden')=='true'
        check("More route opens Settings and dismisses sheet",True)
        page.locator('[data-hayaku-more]').click()
        page.locator('#hayakuMoreSheet [data-hayaku-viewer-goto="logs"]').click()
        assert page.evaluate('__headerTest.Memory.ledgerViewer.activeTab')=='logs'
        assert page.locator('#hayakuMoreSheet').get_attribute('aria-hidden')=='true'
        assert page.locator('.tabbar [data-go="logs"]').count()==0
        check("More route opens Logs and dismisses sheet",True)
        assert not errors, errors
        assert page.evaluate('__hostCalls.llm===0&&__hostCalls.network===0')
        browser.close()
except Exception as error:
    failure = f"{type(error).__name__}: {error}"
    raise
finally:
    (OUT/'results.json').write_text(json.dumps({"pluginSha256":hashlib.sha256(source_bytes).hexdigest(),"passed":sum(row['ok'] for row in results),"failures":[failure] if failure else [],"pageErrors":errors,"results":results},ensure_ascii=False,indent=2))
    print(json.dumps({"pluginSha256":hashlib.sha256(source_bytes).hexdigest(),"passed":sum(row['ok'] for row in results),"failures":[failure] if failure else [],"pageErrors":errors,"out":str(OUT)},ensure_ascii=False))
