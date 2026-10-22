"""Run the deployed GRADIA GUI inside a fullscreen host iframe in Chromium.
Provider traffic is blocked; this verifies UI behavior, not live model quality.
"""
from pathlib import Path
import json, os, shutil
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[3]
SOURCE = Path(os.environ.get('GRADIA_GUI_SOURCE', str(ROOT/'PROGRAM/plugins/GRADIA.js')))
OUT = Path(os.environ.get('GRADIA_WINDOW_OUTPUT', '/tmp/gradia-window-settings'))
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
        page.set_content("""<!doctype html><html><body style='margin:0;background:#283344;color:white'><h1>Chat workspace</h1><iframe id='plugin' title='GRADIA' style='position:fixed;inset:0;width:100%;height:100%;border:0;display:none'></iframe></body></html>""")
        frame = page.frames[1]
        frame.add_script_tag(content=(ROOT/'PROGRAM/tests/browser/gradia_browser_host.js').read_text())
        frame.evaluate("""()=>{
          window.__args=new Map([['backend_hosting_mode','hosted'],['backend_hosting_url','http://127.0.0.1:18787'],['backend_hosting_token','retired-synthetic-token']]);
          window.__local=new Map();risuai.getArgument=async k=>__args.get(k);risuai.setArgument=async(k,v)=>__args.set(k,v);
          risuai.getLocalPluginStorage=async()=>({getItem:async k=>__local.get(k),setItem:async(k,v)=>__local.set(k,v)});
          risuai.showContainer=async mode=>{if(mode!=='fullscreen')throw Error('Unsupported host mode');parent.document.querySelector('#plugin').style.display='block'};
          risuai.hideContainer=async()=>{parent.document.querySelector('#plugin').style.display='none'};
        }""")
        frame.add_script_tag(content=SOURCE.read_text())
        frame.wait_for_function('!!window.__SerialGradationAgentsForRP')
        frame.evaluate('__SerialGradationAgentsForRP.openSettingsGui()')
        frame.locator('#q-language').wait_for(state='visible')

        def go(section):
            frame.evaluate('(s)=>__SerialGradationAgentsForRP.debugNavigateGui(s,"flow")', section)

        def saved_language():
            return frame.evaluate('(async()=> (await __SerialGradationAgentsForRP.getRuntimeSettings()).internal_draft_language)()')

        for index, language in [(1, 'english'), (2, 'japanese'), (0, 'korean')]:
            frame.locator('#q-language .choice').nth(index).click()
            frame.wait_for_function('(i)=>document.querySelectorAll("#q-language .choice")[i].getAttribute("aria-pressed")==="true"', arg=index)
            check(f'{language}: selection changes', frame.locator('#q-language .choice').nth(index).get_attribute('aria-pressed') == 'true')
            frame.locator('#savebar [data-save]').click()
            frame.wait_for_function('!__SerialGradationAgentsForRP.debugGuiStateInfo().dirty')
            check(f'{language}: saved readback', saved_language() == language)
            frame.evaluate('__SerialGradationAgentsForRP.closeSettingsGui()')
            frame.evaluate('__SerialGradationAgentsForRP.openSettingsGui()')
            check(f'{language}: survives reopening', frame.locator('#q-language .choice').nth(index).get_attribute('aria-pressed') == 'true')
        frame.locator('#q-language .choice').nth(1).click()
        frame.locator('#savebar [data-revert]').click()
        frame.wait_for_function('!__SerialGradationAgentsForRP.debugGuiStateInfo().dirty')
        check('cancel restores saved language', saved_language() == 'korean' and frame.locator('#q-language .choice').first.get_attribute('aria-pressed') == 'true')
        check('retired hosting settings do not load', 'backendHosting' not in frame.evaluate('__SerialGradationAgentsForRP.getRuntime()'))
        check('retired hosting panel removed', frame.locator('[data-backend-hosting-panel],[data-backend-action]').count() == 0)

        go('pipeline')
        frame.locator('.node[data-select-row="main"]').click()
        fold = frame.locator('[data-detail="main"] details.fold')
        fold.locator('summary').click()
        nsfw = fold.locator('select[data-existing-response-field="nsfwMode"]')
        check('NSFW scope is visible', '입력 후보와 내부 초안' in fold.inner_text() and 'RisuAI 최종 요청에는 추가하지 않습니다' in fold.inner_text())
        for mode in ['soft', 'direct', 'explicit']:
            nsfw.select_option(mode)
            frame.locator('#savebar [data-save]').click()
            frame.wait_for_function('!__SerialGradationAgentsForRP.debugGuiStateInfo().dirty')
            check(f'NSFW {mode}: saved readback', frame.evaluate('(async()=> (await __SerialGradationAgentsForRP.getRuntimeSettings()).nsfw_mode)()') == mode)
        frame.evaluate('__SerialGradationAgentsForRP.closeSettingsGui()')
        frame.evaluate('__SerialGradationAgentsForRP.openSettingsGui()')
        check('NSFW selection survives reopening', frame.locator('[data-detail="main"] select[data-existing-response-field="nsfwMode"]').input_value() == 'explicit')

        geometry = """()=>{const r=document.querySelector('.app').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,overflow:document.documentElement.scrollWidth-innerWidth,bg:[document.documentElement,document.body,document.querySelector('#sga-rp-gui-root'),document.querySelector('.stage')].map(e=>getComputedStyle(e).backgroundColor)}}"""
        for width, height in [(2556,1363),(1440,1000),(900,1024),(640,900),(390,844),(320,640),(844,390)]:
            page.set_viewport_size({'width': width, 'height': height})
            frame.wait_for_timeout(40)
            g = frame.evaluate(geometry)
            check(f'{width}x{height}: centered', abs(g['x']+g['w']/2-width/2)<=1 and abs(g['y']+g['h']/2-height/2)<=1, g)
            check(f'{width}x{height}: fits viewport', g['w']<=width-30 and g['h']<=height-30 and g['overflow']<=1, g)
            check(f'{width}x{height}: transparent exterior', all(c=='rgba(0, 0, 0, 0)' for c in g['bg']))
            go('references')
            frame.locator('[data-subtab=skill]').click()
            if not frame.locator('[data-skill-customize]').evaluate('e=>e.open'):
                frame.locator('[data-skill-customize] > summary').click()
            choice = frame.locator('[data-skill-selected]').first
            skill_id = choice.get_attribute('data-skill-selected')
            choice.scroll_into_view_if_needed()
            visible = choice.evaluate("""e=>{let r=e.getBoundingClientRect(),row=e.closest('.skill-row').getBoundingClientRect(),p=e.closest('[data-subpanel]');return {fits:r.left>=row.left&&r.right<=row.right&&p.scrollWidth<=p.clientWidth+1,input:r.toJSON(),row:row.toJSON(),panel:[p.clientWidth,p.scrollWidth],overflow:[...p.querySelectorAll('*')].filter(n=>n.getBoundingClientRect().right>p.getBoundingClientRect().right+1).slice(0,5).map(n=>[n.className,n.getBoundingClientRect().width])}}""")
            check(f'{width}x{height}: Skill controls fit', visible['fits'], visible)
            selected = not choice.is_checked()
            choice.set_checked(selected)
            frame.locator('#savebar [data-save]').click()
            frame.wait_for_function('!__SerialGradationAgentsForRP.debugGuiStateInfo().dirty')
            check(f'{width}x{height}: Skill edit readback', frame.locator(f'[data-skill-selected="{skill_id}"]').is_checked() == selected)
            go('management')
            panel = frame.locator('[data-lib-mode-panel]')
            panel.locator('[data-lib-mode-choice=plugin_ipc]').click()
            check(f'{width}x{height}: plugin mode selected', panel.locator('[data-lib-mode-choice=plugin_ipc]').get_attribute('aria-pressed') == 'true')
            check(f'{width}x{height}: server URL hidden in plugin mode', not panel.locator('[data-lib-server-field]').is_visible())
            check(f'{width}x{height}: selection alone is not applied', '연결 없음' in panel.locator('[data-lib-mode-status]').inner_text())
            panel.locator('[data-lib-mode-choice=unified_engine]').click()
            check(f'{width}x{height}: server URL visible', panel.locator('[data-lib-server-field]').is_visible())
            if width == 1440:
                page.screenshot(path=str(OUT/'settings-desktop.png'))
            if width == 390:
                page.screenshot(path=str(OUT/'settings-mobile.png'))
        check('no provider or obsolete bridge calls', frame.evaluate('__networkCalls') == 0)
        check('no uncaught browser errors', not errors, errors)
    finally:
        (OUT/'results.json').write_text(json.dumps({'source': str(SOURCE), 'checks': results, 'errors': errors}, ensure_ascii=False, indent=2))
        browser.close()
print(json.dumps({'passed': len(results), 'source': str(SOURCE), 'output': str(OUT)}, ensure_ascii=False))
