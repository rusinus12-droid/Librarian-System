"""Actual GRADIA source mount, deterministic storage, and canonical layout comparison.
No production provider/model/network request is allowed by this fixture.
"""
import asyncio, hashlib, json, os, re
from pathlib import Path
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[3]
SOURCE=ROOT/'PROGRAM/plugins/GRADIA.js'
EXECUTED_SOURCE=Path(os.environ.get('GRADIA_FULL_ARTIFACT',str(SOURCE)))
if os.environ.get('GRADIA_FULL_ARTIFACT'):
    assert EXECUTED_SOURCE.read_bytes()==SOURCE.read_bytes(), 'official Full must match the current product source byte-for-byte'
SITE=ROOT/'PROGRAM/docs/gui-redesign'
OUT=Path(os.environ.get('GRADIA_BROWSER_OUTPUT',ROOT/'PROGRAM/docs/gui-redesign/verification/gradia-root-runtime'))
HOST=(Path(__file__).parent/'gradia_browser_host.js').read_text()

async def mount(browser,width=1440,height=1000):
    page=await browser.new_page(viewport={'width':width,'height':height},accept_downloads=True)
    page.set_default_timeout(10000)
    await page.set_content('<!doctype html><html lang="ko"><meta charset="utf-8"><body></body></html>')
    await page.evaluate(HOST)
    await page.add_script_tag(path=str(EXECUTED_SOURCE))
    await page.wait_for_function('window.__SerialGradationAgentsForRP?.openSettingsGui')
    await page.evaluate('window.__SerialGradationAgentsForRP.openSettingsGui()')
    return page

async def main():
    OUT.mkdir(parents=True,exist_ok=True)
    results={};errors=[]
    async with async_playwright() as pw:
        browser=await pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
        page=await mount(browser);page.on('pageerror',lambda error:errors.append(str(error)))
        assert await page.evaluate('document.compatMode')=='CSS1Compat'
        await page.locator('.sidebar [data-go="providers"]').click()
        before=await page.locator('[data-page="providers"] button.row').count()
        await page.locator('[data-provider-clone]:visible').click()
        assert await page.locator('[data-page="providers"] button.row').count()==before+1
        results['provider_clone']=True
        await page.locator('[data-provider-field="key"]:visible').fill('synthetic-not-a-live-key')
        await page.locator('[data-save]').click()
        await page.locator('[data-provider-key-delete]:visible').click()
        # Let the dialog's deferred initial-focus task settle before testing
        # keyboard wrapping, so it cannot race the synthetic Shift+Tab.
        await page.wait_for_timeout(50)
        await page.locator('.overlay.is-open .dialog button').first.focus()
        await page.keyboard.press('Shift+Tab')
        assert await page.locator('.overlay.is-open .dialog button').last.evaluate('(node)=>node===document.activeElement')
        await page.keyboard.press('Tab')
        assert await page.locator('.overlay.is-open .dialog button').first.evaluate('(node)=>node===document.activeElement')
        await page.keyboard.press('Escape')
        assert await page.locator('[data-provider-key-delete]:visible').evaluate('(node)=>node===document.activeElement')
        results['modal_focus_trap_and_return']=True
        await page.locator('[data-provider-key-delete]:visible').click()
        await page.locator('.overlay.is-open .dialog button').last.click()
        await page.locator('[data-save]').click()
        assert await page.locator('[data-provider-field="key"]:visible').get_attribute('placeholder')=='API 키 입력'
        results['key_delete_readback']=True
        await page.locator('.sidebar [data-go="manage"]').click()
        await page.locator('[data-export-scope="all"]').click()
        assert await page.locator('[data-export-scope="all"]').get_attribute('aria-pressed')=='true'
        results['full_export_scope']=True
        await page.locator('.sidebar [data-go="pipeline"]').click()
        await page.locator('.node[data-select-row="char"]').click()
        await page.locator('[data-open="dlg-ooc"]:visible').click()
        await page.locator('.overlay.is-open textarea').fill('synthetic direction')
        assert not await page.locator('.overlay.is-open button',has_text='보내기').is_disabled()
        await page.locator('.overlay.is-open .dialog button').filter(has_text='닫기').first.click()
        results['ooc_typing_enabled']=True
        # Existing per-stage Skill disablement is saved and read back; no global policy.
        await page.locator('.sidebar [data-go="sources"]').click()
        await page.locator('[data-subtab="skill"]').click()
        skill=page.locator('[data-skill-priority]').first
        await skill.fill('0');await skill.dispatch_event('change')
        await page.locator('[data-save]').click()
        await page.locator('.sidebar [data-go="home"]').click()
        await page.locator('.sidebar [data-go="sources"]').click()
        await page.locator('[data-subtab="skill"]').click()
        assert await page.locator('[data-skill-priority]').first.input_value()=='0'
        results['stage_skill_zero_readback']=True
        await page.locator('.sidebar [data-go="pipeline"]').click()
        await page.locator('.node[data-select-row="world"]').click()
        world=page.locator('.stage-detail[data-detail="world"]')
        for stage in ['aide_character','aide_world','aide_plot']:
            values=await page.locator('[data-stage-provider="'+stage+'"] option').evaluate_all('(rows)=>rows.map(row=>row.value)')
            assert 'default' in values
            assert not any('gpt-4.1' in value or 'claude-sonnet' in value for value in values)
        await world.locator('[data-stage-provider="aide_world"]').select_option('default')
        await world.locator('[data-stage-field="maxChars"]').fill('4200')
        await world.locator('[data-stage-field="timeoutSeconds"]').fill('47')
        await page.locator('[data-save]').click()
        settings=await page.evaluate('__SerialGradationAgentsForRP.readGuiSettings()')
        assert settings['agentSlots']['aide_world']['max_chars']==4200
        assert settings['agentSlots']['aide_world']['timeout_ms']==47000
        assert settings['agentSlots']['aide_world']['preset']=='default'
        results['reference_budget_and_timeout_units']=True
        results['aide_actual_provider_readback']=True
        await page.locator('.node[data-select-row="inp"]').click()
        await page.locator('[data-input-assist-options] summary').click()
        assist=page.locator('[data-input-assist-options]')
        await assist.locator('[data-input-assist-stage-field="maxChars"]').fill('3500')
        await assist.locator('[data-input-assist-stage-field="presetName"]').select_option(index=1)
        await page.locator('[data-save]').click()
        settings=await page.evaluate('__SerialGradationAgentsForRP.readGuiSettings()')
        assert settings['agentSlots']['input_assist']['max_chars']==3500
        assert settings['agentSlots']['input_assist']['preset']=='default'
        results['input_assist_existing_fields']=True
        await page.locator('.sidebar [data-go="providers"]').click()
        name=page.locator('[data-provider-field="name"]:visible')
        renamed=(await name.input_value())+' synthetic'
        await name.fill(renamed)
        assert await name.input_value()==renamed
        await name.press('Tab')
        assert await page.locator('[data-page="providers"] button.row').filter(has_text=renamed).count()==1
        results['rename_survives_typing']=True
        await page.locator('.sidebar [data-go="manage"]').click()
        await page.locator('[data-subtab="adv"]').click()
        debug=page.locator('[aria-label="진단 기록"]')
        await debug.select_option('true');await page.locator('[data-save]').click()
        await debug.select_option('false');await page.locator('[data-save]').click()
        settings=await page.evaluate('__SerialGradationAgentsForRP.readGuiSettings()')
        assert settings['runtime']['debug_log'] in (False,'false')
        results['boolean_settings_readback']=True
        for _ in range(3):
            await page.evaluate('__SerialGradationAgentsForRP.closeSettingsGui()')
            await page.evaluate('__SerialGradationAgentsForRP.openSettingsGui()')
            assert await page.locator('#sga-rp-gui-root .app').count()==1
        await page.locator('.sidebar [data-go="providers"]').click()
        before=await page.locator('[data-page="providers"] button.row').count()
        await page.locator('[data-provider-clone]:visible').click()
        assert await page.locator('[data-page="providers"] button.row').count()==before+1
        results['reopen_has_single_shell_and_handler']=True
        assert await page.evaluate('__networkCalls')==0
        await page.close()
        html=(SITE/'gradia.html').read_text()
        html=re.sub(r'<link rel="stylesheet" href="([^"]+)">',lambda m:'<style>'+(SITE/m.group(1)).read_text()+'</style>',html)
        html=re.sub(r'<script src="([^"]+)"></script>',lambda m:'<script>'+(SITE/m.group(1)).read_text()+'</script>',html)
        geometry=[]
        for width,height in [(1440,1000),(820,1000),(390,844),(900,900),(640,900),(641,900),(901,900)]:
            reference=await browser.new_page(viewport={'width':width,'height':height});await reference.set_content(html)
            actual=await mount(browser,width,height);actual.on('pageerror',lambda error:errors.append(str(error)))
            await reference.evaluate('document.fonts.ready');await actual.evaluate('document.fonts.ready')
            # Preserve interior layout comparisons while applying the product's
            # centered, viewport-bounded window requirement to the reference.
            await reference.add_style_tag(content='.proto-bar{display:none!important}.stage{height:100dvh;padding:16px;align-items:center;overflow:hidden}.frame{height:min(830px,100%);min-height:0}')
            await reference.wait_for_timeout(100);await actual.wait_for_timeout(100)
            metric="""()=>Object.fromEntries(['.frame','.app','.topbar','.sidebar','.page-body','#savebar'].map(s=>{let e=document.querySelector(s),r=e.getBoundingClientRect();return[s,{x:r.x,y:r.y,w:r.width,h:r.height,display:getComputedStyle(e).display}]}))"""
            ref=await reference.evaluate(metric);product=await actual.evaluate(metric)
            for selector in ref:
                assert abs(ref[selector]['w']-product[selector]['w'])<0.01,(width,selector,ref,product)
                assert abs(ref[selector]['h']-product[selector]['h'])<0.01,(width,selector,ref,product)
                assert abs(ref[selector]['x']-product[selector]['x'])<0.01,(width,selector,ref,product)
                assert abs(ref[selector]['y']-product[selector]['y'])<0.01,(width,selector,ref,product)
            assert await actual.locator('#sga-rp-gui-root > .stage > .frame > .app').count()==1
            ref_canvas=await reference.evaluate('getComputedStyle(document.body).backgroundColor')
            product_canvas=await actual.evaluate("getComputedStyle(document.querySelector('#sga-rp-gui-root')).backgroundColor")
            assert product_canvas=='rgba(0, 0, 0, 0)',(width,'transparent window exterior',product_canvas)
            nav_metric="""()=>{const n=document.querySelector('.tabbar'),r=n.getBoundingClientRect();return {display:getComputedStyle(n).display,x:r.x,y:r.y,w:r.width,h:r.height,items:[...n.children].map(b=>({text:b.textContent.trim(),go:b.dataset.go||'',more:b.dataset.more||'',icons:[...b.querySelectorAll('svg')].map(svg=>{const u=svg.querySelector('use');return u?document.querySelector(u.getAttribute('href')).innerHTML:svg.innerHTML})}))}}"""
            ref_nav=await reference.evaluate(nav_metric);product_nav=await actual.evaluate(nav_metric)
            assert product_nav==ref_nav,(width,'canonical bottom navigation',ref_nav,product_nav)
            if product_nav['display']!='none':
                assert len(product_nav['items'])==5
                assert await actual.locator('.tabbar button').evaluate_all("bs=>bs.every(b=>{let r=b.getBoundingClientRect();return r.width>=44&&r.height>=44&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===b})")
                more=actual.locator('.tabbar [data-more]')
                await more.click()
                sheet=actual.locator('#sheet-more.is-open')
                assert await sheet.count()==1
                await reference.locator('.tabbar [data-more]').click()
                sheet_metric="""()=>{let s=document.querySelector('#sheet-more .sheet'),r=s.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,rows:[...s.querySelectorAll('button')].map(b=>({text:b.textContent.trim(),go:b.dataset.go,icons:[...b.querySelectorAll('svg')].map(svg=>{let u=svg.querySelector('use');return u?document.querySelector(u.getAttribute('href')).innerHTML:svg.innerHTML})}))}}"""
                assert await actual.evaluate(sheet_metric)==await reference.evaluate(sheet_metric),(width,'canonical More sheet')
                await reference.keyboard.press('Escape')
                assert await sheet.locator('[data-go]').evaluate_all("bs=>bs.map(b=>b.dataset.go)")==['providers','manage']
                await actual.keyboard.press('Shift+Tab')
                assert await sheet.locator('[data-go=manage]').evaluate('(b)=>b===document.activeElement')
                await actual.keyboard.press('Tab')
                assert await sheet.locator('[data-go=providers]').evaluate('(b)=>b===document.activeElement')
                await actual.keyboard.press('Escape')
                assert await actual.locator('#sheet-more.is-open').count()==0
                assert await more.evaluate('(b)=>b===document.activeElement')
                await actual.keyboard.press('Enter')
                await actual.locator('#sheet-more [data-go=providers]').click()
                assert await actual.locator('.page[data-page=providers].is-active').count()==1
                assert await actual.locator('#sheet-more.is-open').count()==0
                assert await more.evaluate('(b)=>b===document.activeElement')
                await more.click()
                await actual.locator('#sheet-more [data-go=manage]').click()
                assert await actual.locator('.page[data-page=manage].is-active').count()==1
                assert await actual.locator('#sheet-more.is-open').count()==0
                await actual.evaluate("document.querySelector('.tabbar [data-go=home]').click()")
            routes=['home','pipeline','results','sources','providers','manage']
            for route in routes:
                await actual.evaluate("route=>document.querySelector('.sidebar [data-go='+route+']').click()",route)
                assert await actual.locator(f'.page[data-page="{route}"].is-active').count()==1
                assert not await actual.locator('.page.is-active').evaluate('(e)=>e.scrollWidth>e.clientWidth+1')
                content=await actual.locator('.page.is-active').inner_text()
                assert '6.2초' not in content and '33 / 41' not in content and '12 / 14' not in content
                if route=='results':
                    assert await actual.locator('[data-subtabs="rs"] button').count()==5
                await actual.mouse.move(0,0)
                await actual.screenshot(path=str(OUT/f'product_{route}_{width}.png'))
            await actual.evaluate("document.querySelector('.sidebar [data-go=home]').click()")
            await actual.mouse.move(0,0);await reference.mouse.move(0,0)
            await reference.screenshot(path=str(OUT/f'reference_home_{width}.png'))
            await actual.screenshot(path=str(OUT/f'product_home_{width}.png'))
            assert await actual.evaluate('__networkCalls')==0
            geometry.append({'width':width,'height':height,'reference':ref,'product':product,'referenceCanvasColor':ref_canvas,'productCanvasColor':product_canvas,'compatMode':await actual.evaluate('document.compatMode'),'routes':routes,'referenceNavigation':ref_nav,'productNavigation':product_nav})
            await reference.close();await actual.close()
        await browser.close()
    assert not errors,errors
    data={'pluginSourceSha256':hashlib.sha256(SOURCE.read_bytes()).hexdigest(),'executedSource':str(EXECUTED_SOURCE),'executedSourceSha256':hashlib.sha256(EXECUTED_SOURCE.read_bytes()).hexdigest(),'method':'unmodified product bytes in standard-mode synthetic Risu host; no installed real Risu or product capture CSS overrides','results':results,'geometry':geometry,'pageErrors':errors,'providerNetworkCalls':0}
    (OUT/'result.json').write_text(json.dumps(data,ensure_ascii=False,indent=2))
    print(json.dumps(data,ensure_ascii=False))

if __name__=='__main__':asyncio.run(main())
