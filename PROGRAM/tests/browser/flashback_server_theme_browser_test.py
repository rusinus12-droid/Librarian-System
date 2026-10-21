"""Whole FLASHBACK server page: native Flashback palette, readable text and migration consent.
Synthetic host/storage; no live backend or LLM requests.
"""
from pathlib import Path
import json,os,shutil
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[3]
OUT=Path(os.environ.get('FLASHBACK_SERVER_BROWSER_OUTPUT','/tmp/flashback-server-theme-browser'));OUT.mkdir(parents=True,exist_ok=True)
checks=[];errors=[]
def check(name,result,detail=None):
    checks.append({'name':name,'ok':bool(result),'detail':detail})
    assert result,f'{name}: {detail}'
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=shutil.which('chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
    try:
        page=browser.new_page(viewport={'width':1440,'height':1000});page.set_default_timeout(15000)
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.route('http://localhost/**',lambda route:route.fulfill(status=200,content_type='text/html',body='<html><body></body></html>'))
        page.goto('http://localhost/flashback-server')
        page.set_content('<body style="margin:0;background:#29333c"><iframe id="plugin" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe></body>')
        frame=page.frames[1];frame.add_script_tag(path=str(ROOT/'PROGRAM/tests/browser/hayaku_browser_host.js'))
        frame.add_script_tag(content=(ROOT/'PROGRAM/plugins/Flashback_Memory.js').read_text())
        frame.wait_for_function('!!window.__FlashbackMemory');frame.evaluate('__FlashbackMemory.showUi()')
        frame.locator('.sidebar [data-go=connect]').click();frame.locator('button[data-group=c][data-subtab=srv]').click()
        frame.locator('.mscx-scope-root [data-apply]').wait_for()
        panel=frame.locator('#flashbackMemorySuiteServerConnectionPanel')
        check('one full-width storage panel',panel.locator('.mscx-scope-root').count()==1 and panel.locator('[data-scope-manager]').count()==0)
        check('mode choice remains explicit',panel.locator('input[type=radio]').count()==2)
        palette=panel.evaluate("e=>{const r=e.querySelector('.mscx-scope-root'),s=getComputedStyle(e.closest('.t-flashback'));return {text:getComputedStyle(r).color,bg:getComputedStyle(r.querySelector(':scope>.mscx-card')).backgroundColor,primary:getComputedStyle(r.querySelector('button.primary')).backgroundColor,expectedText:s.getPropertyValue('--text').trim(),expectedBg:s.getPropertyValue('--surface').trim(),expectedPrimary:s.getPropertyValue('--accent').trim()}}")
        def rgb(hexcolor):
            return 'rgb('+', '.join(str(int(hexcolor[i:i+2],16)) for i in (1,3,5))+')'
        check('native FLASHBACK text and card colors',palette['text']==rgb(palette['expectedText']) and palette['bg']==rgb(palette['expectedBg']),palette)
        check('selected scope hint uses readable accent',panel.locator('.scopetoggle button[aria-pressed=true] small').evaluate("e=>getComputedStyle(e).color===getComputedStyle(e.parentElement).color"))
        contrast=panel.evaluate(r"""e=>{
            const rgb=value=>(value.match(/[\d.]+/g)||[]).map(Number);
            const luminance=c=>c.slice(0,3).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4}).reduce((v,x,i)=>v+x*[.2126,.7152,.0722][i],0);
            const selectors=['.scope b','[data-scope-label]','[data-scope-id]','.scopetoggle button[aria-pressed=true] small','h3','.mscx-card>div>.muted','label.mode b','label.mode small','[data-server-fields] b','[data-server-hint]','[data-status]','[data-test]','[data-apply]'];
            return selectors.flatMap(selector=>[...e.querySelectorAll(selector)].map(node=>{
                const style=getComputedStyle(node),fg=rgb(style.color);let bg=null,opacity=1;
                for(let p=node;p;p=p.parentElement){const cs=getComputedStyle(p);opacity*=Number(cs.opacity);const c=rgb(cs.backgroundColor);if(!bg&&c.length>=3&&(c.length<4||c[3]===1))bg=c;}
                const a=luminance(fg),b=luminance(bg||[255,255,255]);return {selector,text:node.textContent.trim().slice(0,48),color:style.color,background:bg,opacity,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
            }));
        }""")
        check('scope title and global hint contrast at least 4.5:1',all(row['ratio']>=4.5 and row['opacity']==1 for row in contrast if row['selector'] in ['.scope b','.scopetoggle button[aria-pressed=true] small']),contrast)
        check('all ordinary server text contrast at least 4.5:1',all(row['ratio']>=4.5 and row['opacity']==1 for row in contrast),contrast)
        check('native FLASHBACK accent',palette['primary']==rgb(palette['expectedPrimary']),palette)
        panel.locator('.scopetoggle').screenshot(path=str(OUT/'FLASHBACK-server-text-contrast.png'))
        for width,height in [(1440,1000),(1024,900),(900,1024),(768,1024),(640,900),(390,844),(320,640),(844,390)]:
            page.set_viewport_size({'width':width,'height':height});frame.wait_for_timeout(180)
            geometry=panel.evaluate("e=>{const r=e.getBoundingClientRect(),labels=[...e.querySelectorAll('label.mode')].map(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width}});return {x:r.x,right:r.right,w:r.width,overflow:e.scrollWidth-e.clientWidth,labels}}")
            check(f'{width}x{height}: current scope remains readable',panel.locator('.scope:not([data-mode-summary])').evaluate("e=>{const r=e.getBoundingClientRect();return r.width>100&&r.height>30&&getComputedStyle(e.querySelector('b')).color===getComputedStyle(e.closest('.mscx-scope-root')).color}"))
            check(f'{width}x{height}: fits page',geometry['x']>=0 and geometry['right']<=width+1 and geometry['overflow']<=1,geometry)
            if width<=390:check(f'{width}: single-column modes',geometry['labels'][1]['y']>geometry['labels'][0]['y'] and abs(geometry['labels'][1]['x']-geometry['labels'][0]['x'])<2,geometry)
            for selector in ['[data-url]','[data-test]','[data-apply]']:
                control=panel.locator(selector);control.evaluate("e=>e.scrollIntoView({block:'center'})")
                check(f'{width}x{height}: {selector} reachable',control.evaluate("e=>{const r=e.getBoundingClientRect();return r.width>40&&r.height>=36&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}"))
            if width in [1440,1024,390]:
                panel.evaluate("e=>e.scrollIntoView({block:'start'})")
                page.screenshot(path=str(OUT/f'FLASHBACK-server-{width}.png'))
        page.set_viewport_size({'width':1440,'height':1000});frame.wait_for_timeout(180)
        panel.locator('input[value=server_only]').check();check('server mode selection works',panel.locator('input[value=server_only]').is_checked())
        panel.locator('input[value=plugin_only]').check();check('plugin mode selection works',panel.locator('input[value=plugin_only]').is_checked())
        panel.locator('[data-url]').fill('http://127.0.0.1:47630');check('server URL editable',panel.locator('[data-url]').input_value()=='http://127.0.0.1:47630')
        check('editing mode and URL makes no requests',frame.evaluate('__hostCalls.network===0&&__hostCalls.llm===0'))
        panel.locator('[data-apply]').click();panel.locator('[data-mode-confirm]').wait_for(state='visible')
        check('migration still requires in-panel consent',panel.locator('[data-mode-confirm-approve]').is_visible())
        panel.locator('[data-mode-confirm-cancel]').click();panel.locator('[data-mode-confirm]').wait_for(state='hidden')
        check('cancel retains storage mode',frame.evaluate("async()=>await risuai.getArgument('memory_suite_server_mode')==='plugin_only'"))
        panel.locator('.mscx-advanced > summary').click();check('advanced maintenance remains available',panel.locator('[data-sync]').is_visible() and panel.locator('[data-delete]').is_visible())
        check('no model or external calls',frame.evaluate('__hostCalls.network===0&&__hostCalls.llm===0'))
        check('no uncaught browser errors',not errors,errors)
    finally:
        (OUT/'results.json').write_text(json.dumps({'checks':checks,'errors':errors},ensure_ascii=False,indent=2));browser.close()
print(json.dumps({'passed':len(checks),'output':str(OUT)}))
