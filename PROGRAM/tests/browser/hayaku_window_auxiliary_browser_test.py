"""Exact HAYAKU source/Min in Chromium and a synthetic fullscreen host iframe.
Model responses are controlled at runLLMModel; no live provider or user data.
"""
from pathlib import Path
import json, os, shutil
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[3]
SOURCE = Path(os.environ.get('HAYAKU_GUI_SOURCE', str(ROOT/'PROGRAM/plugins/HAYAKU_Locator_Continuity.js')))
OUT = Path(os.environ.get('HAYAKU_WINDOW_OUTPUT', '/tmp/hayaku-window-controls'))
OUT.mkdir(parents=True, exist_ok=True)
results, errors = [], []

def check(name, condition, detail=None):
    results.append({'name': name, 'ok': bool(condition), 'detail': detail})
    assert condition, f'{name}: {detail}'

with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'), headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    page.set_default_timeout(7000)
    page.on('pageerror', lambda error: errors.append(str(error)))
    try:
        page.set_content("""<!doctype html><html><body style='margin:0;background:#283344;color:white;font:20px system-ui'><main style='padding:40px'><h1>Chat workspace</h1><p>Host content around HAYAKU.</p></main><iframe id='plugin' title='HAYAKU' style='position:fixed;inset:0;width:100%;height:100%;border:0;display:none'></iframe></body></html>""")
        frame = page.frames[1]
        frame.add_script_tag(content=(ROOT/'PROGRAM/tests/browser/hayaku_browser_host.js').read_text())
        frame.evaluate("""()=>{
          risuai.showContainer=async mode=>{if(mode!=='fullscreen')throw Error('Unsupported host mode');parent.document.querySelector('#plugin').style.display='block'};
          risuai.hideContainer=async()=>{parent.document.querySelector('#plugin').style.display='none'};
          window.__probeMode='success';window.__probeRequests=[];
          risuai.runLLMModel=async(messages,options)=>{__hostCalls.llm++;__probeRequests.push(messages);if(__probeMode==='fail')throw Error('synthetic provider offline');if(__probeMode==='hold')return await new Promise(resolve=>window.__releaseProbe=()=>resolve({type:'success',result:'HAYAKU OK'}));return {type:'success',result:'HAYAKU OK'}};
        }""")
        frame.add_script_tag(content=SOURCE.read_text())
        frame.wait_for_function('!!window.HAYAKU')
        frame.evaluate('HAYAKU.showUi()')
        frame.locator('[data-hayaku-auxiliary-test]').wait_for(state='visible')
        frame.wait_for_function('!document.querySelector("[data-hayaku-auxiliary-test]").disabled')
        check('opening the viewer has zero model calls', frame.evaluate('__hostCalls.llm') == 0)
        check('packet coverage and Other Ax are distinct', '패킷 연결률' in frame.locator('#hayakuOverviewCoverageBadge').inner_text())

        def go(tab):
            frame.locator(f'[data-hayaku-viewer-tab="{tab}"]:visible,[data-hayaku-viewer-goto="{tab}"]:visible').first.click()
            frame.locator(f'#hayakuViewerPanel{tab.capitalize()}.is-active').wait_for(state='visible')

        geometry = """()=>{const a=document.querySelector('.app'),r=a.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,backgrounds:[document.documentElement,document.body,document.querySelector('[data-hayaku-viewer-backdrop]'),document.querySelector('.stage')].map(n=>getComputedStyle(n).backgroundColor),overflow:document.documentElement.scrollWidth-innerWidth}}"""
        for width, height in [(2556,1363),(1440,1000),(900,1024),(640,900),(390,844),(320,640),(844,390)]:
            page.set_viewport_size({'width': width, 'height': height})
            frame.wait_for_timeout(40)
            g = frame.evaluate(geometry)
            check(f'{width}x{height}: centered', abs(g['x']+g['width']/2-width/2)<=1 and abs(g['y']+g['height']/2-height/2)<=1, g)
            check(f'{width}x{height}: fits screen', g['width']<=width-30 and g['height']<=height-30 and g['overflow']<=1, g)
            check(f'{width}x{height}: transparent exterior', all(color=='rgba(0, 0, 0, 0)' for color in g['backgrounds']))
            frame.locator('[data-hayaku-auxiliary-test]').click()
            modal = frame.locator('#hayakuAuxiliaryProbeConfirm')
            modal.wait_for(state='visible')
            check(f'{width}: price and call count visible', all(text in modal.inner_text() for text in ['LLM', '비용', '1회', '동의']))
            check(f'{width}: no call before approval', frame.evaluate('__hostCalls.llm') == 0)
            modal.locator('[data-auxiliary-confirm="cancel"]').click()
            modal.wait_for(state='detached')
            check(f'{width}: cancellation makes zero calls', frame.evaluate('__hostCalls.llm') == 0)
            if width in [2556,390]:
                page.screenshot(path=str(OUT/f'{width}_overview.png'))
            # Narrow layouts expose Settings through the bottom More sheet.
            if frame.locator('[data-hayaku-viewer-tab="settings"]:visible').count():
                frame.locator('[data-hayaku-viewer-tab="settings"]:visible').click()
            else:
                frame.locator('[data-hayaku-more]').click()
                frame.locator('#hayakuMoreSheet [data-hayaku-viewer-goto="settings"]').click()
            frame.locator('[data-hayaku-settings-section-button="safe"]').click()
            row = frame.locator('.setting').filter(has=frame.locator('#st-packet-recovery'))
            badge = row.locator('[data-setting-state="packet-recovery"]')
            badge.scroll_into_view_if_needed()
            b, r = badge.bounding_box(), row.bounding_box()
            check(f'{width}: readable recovery state', badge.inner_text() == '사용 · 저장됨' and b['width']>45 and b['height']>=18 and b['x']>=r['x'] and b['x']+b['width']<=r['x']+r['width']+1, {'badge':b,'row':r})
            check(f'{width}: recovery description present', 'afterRequest' in row.locator('.setting__desc').inner_text())
            row.locator('label.switch').click()
            check(f'{width}: draft state is explicit', badge.inner_text() == '사용 안 함 · 저장 전')
            frame.locator('#cancelHayakuSettings').click()
            frame.wait_for_function('document.querySelector("#st-packet-recovery").checked')
            check(f'{width}: cancel restores saved state', badge.inner_text() == '사용 · 저장됨')
            if width in [1440,390]:
                page.screenshot(path=str(OUT/f'{width}_recovery_settings.png'))
            go('overview')
        check('settings navigation and edits make zero model calls', frame.evaluate('__hostCalls.llm')==0)
        page.set_viewport_size({'width':1440,'height':1000})
        trigger = frame.locator('[data-hayaku-auxiliary-test]')
        trigger.click()
        frame.locator('#hayakuAuxiliaryProbeConfirm').wait_for(state='visible')
        frame.evaluate('HAYAKU.closeUi()')
        check('closing dismisses pending approval', frame.locator('#hayakuAuxiliaryProbeConfirm').count()==0 and frame.evaluate('__hostCalls.llm')==0)
        frame.evaluate('HAYAKU.showUi()')
        trigger.click()
        frame.locator('#hayakuAuxiliaryProbeConfirm').wait_for(state='visible')
        frame.locator('[data-auxiliary-confirm="cancel"]').focus()
        page.keyboard.press('Escape')
        check('Escape declines without a call', frame.locator('#hayakuAuxiliaryProbeConfirm').count()==0 and frame.evaluate('__hostCalls.llm')==0)
        trigger.click()
        frame.locator('#hayakuAuxiliaryProbeConfirm').wait_for(state='visible')
        page.screenshot(path=str(OUT/'cost_confirmation.png'))
        frame.evaluate("__probeMode='hold'")
        frame.locator('[data-auxiliary-confirm="approve"]').click()
        frame.wait_for_function('__hostCalls.llm===1 && typeof __releaseProbe==="function"')
        frame.locator('[data-hayaku-auxiliary-test]').dispatch_event('click')
        check('one approval and repeat click submit exactly one call', frame.evaluate('__hostCalls.llm')==1 and trigger.is_disabled())
        frame.evaluate('HAYAKU.closeUi()'); frame.evaluate('HAYAKU.showUi()')
        check('reopening during the request keeps one call and locked test controls', frame.evaluate('__hostCalls.llm')==1 and trigger.is_disabled())
        frame.evaluate('__releaseProbe()')
        frame.wait_for_function('document.querySelector("#hayakuOverviewAuxiliaryStatus").textContent.includes("성공") && !document.querySelector("[data-hayaku-auxiliary-test]").disabled')
        check('success updates Other Ax, not packet coverage', '성공' in frame.locator('#hayakuSidebarAux').inner_text() and '패킷 연결률' in frame.locator('#hayakuOverviewCoverageBadge').inner_text())
        check('request uses actual Other Ax transport', frame.evaluate('__probeRequests[0].mode')=='otherAx')
        frame.evaluate("__probeMode='fail'")
        trigger.click(); frame.locator('[data-auxiliary-confirm="approve"]').click()
        frame.wait_for_function('document.querySelector("#hayakuOverviewAuxiliaryStatus").textContent.includes("실패") && !document.querySelector("[data-hayaku-auxiliary-test]").disabled')
        check('failure is shown with one call and no retry', frame.evaluate('__hostCalls.llm')==2)
        # Existing settings test must pass through the same cost dialog.
        go('settings'); frame.locator('[data-hayaku-settings-section-button="adv"]').click()
        if not frame.locator('#ax-test').is_visible():
            frame.locator('[data-hayaku-settings-view="full"]').click()
        frame.locator('#ax-test').click()
        frame.locator('#hayakuAuxiliaryProbeConfirm').wait_for(state='visible')
        check('existing settings test also waits for approval', frame.evaluate('__hostCalls.llm')==2)
        frame.locator('[data-auxiliary-confirm="cancel"]').click()
        check('no host network path used', frame.evaluate('__hostCalls.network')==0)
        check('no browser script errors', not errors, errors)
        frame.evaluate('__dispose()')
    finally:
        (OUT/'results.json').write_text(json.dumps({'source':str(SOURCE),'method':'real Chromium, exact plugin, synthetic host/model boundary','passed':sum(r['ok'] for r in results),'total':len(results),'errors':errors,'results':results},ensure_ascii=False,indent=2))
        browser.close()
for row in results:
    print(('PASS ' if row['ok'] else 'FAIL ')+row['name'])
print(json.dumps({'passed':sum(r['ok'] for r in results),'total':len(results),'errors':errors}))
