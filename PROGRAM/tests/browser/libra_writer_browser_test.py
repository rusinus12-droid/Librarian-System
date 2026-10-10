"""Full shipped LIBRA JS in Chromium; host/model responses are deterministic test doubles.
The injected seam exposes real private helpers in browser memory, not in the artifact.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json, sys, shutil
R=Path(sys.argv[1]) if len(sys.argv)>1 else Path(__file__).resolve().parents[2]
E=Path(sys.argv[2]) if len(sys.argv)>2 else R.parent.parent/'LIBRA_WRITER_BROWSER'
E.mkdir(parents=True,exist_ok=True)
s=(R/'plugins/LIBRA.js').read_text()
a='  const publicApi = Object.freeze({\n    getHostLineageStatus: () => LibraMemoryCore'
assert s.count(a)==1
s=s.replace(a,'  globalThis.__writer = {Gui, Runtime, loadSettings, showLibraInputWriterChoicePicker, showLibraInputWriterDeliveryPicker};\n'+a)
host=(Path(__file__).parent/'libra_writer_host.js').read_text()
results=[];errors=[]
def check(name,yes,detail=None):
 results.append({'name':name,'ok':bool(yes),'detail':detail})
 if not yes: raise AssertionError(f'{name}: {detail}')
contrast="""(selector)=>{const n=document.querySelector(selector),s=getComputedStyle(n),rgb=x=>(x.match(/[\\d.]+/g)||[]).map(Number);let p=n,bg;while(p){const c=rgb(getComputedStyle(p).backgroundColor);if(c.length===3||c[3]>=.99){bg=c;break;}p=p.parentElement;}bg=bg||[255,255,255];const fg=rgb(s.color);const lum=c=>c.slice(0,3).map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((a,x,i)=>a+x*[.2126,.7152,.0722][i],0);const a=lum(fg),b=lum(bg);return {ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),fg,bg};}"""
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path=shutil.which('chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
  page=browser.new_page(viewport={'width':1440,'height':1000})
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.on('dialog',lambda d:d.dismiss())
  page.set_content('<!doctype html><html lang="ko"><meta charset="utf-8"><body style="margin:0"></body></html>')
  page.add_script_tag(content=host);page.add_script_tag(content=s)
  page.wait_for_function('!!window.__LIBRA__ && __writerHost.stores.chat.some(x=>x.id==="libra-input-writer-button")',timeout=30000)
  check('writer registers in actual chat store',page.evaluate('__writerHost.stores.chat.find(x=>x.id==="libra-input-writer-button").name')=='LIBRA로 인풋 작성하기')
  check('no automatic input hook',page.evaluate('!__writerHost.calls.inputHooks.includes("input")'))
  page.evaluate('__writerHost.showMode="pending";__writerHost.click()')
  page.locator('.libra-input-writer-modal.composer').wait_for(timeout=10000)
  check('cold composer painted before showContainer acknowledgement',page.evaluate('__writerHost.calls.show.at(-1).hasComposer && __writerHost.pendingShows.length===1'))
  page.get_by_role('button',name='취소',exact=True).click()
  page.wait_for_function('!__writer.Runtime.inputWriterBusy')
  check('cancel settles even while container RPC is pending',page.evaluate('__writerHost.calls.model===0 && __writerHost.calls.send.length===0'))
  page.evaluate('__writerHost.resolveShows();__writerHost.showMode="normal"')
  page.wait_for_timeout(40)
  for width in [1440,1024,768,390]:
   page.set_viewport_size({'width':width,'height':1000 if width>600 else 844})
   page.evaluate('__writerHost.click()')
   modal=page.locator('.libra-input-writer-modal.composer');modal.wait_for()
   check(f'{width}: one compact composer',modal.count()==1)
   fit=modal.evaluate('(n)=>{const r=n.getBoundingClientRect();return {right:r.right,left:r.left,bottom:r.bottom,top:r.top,scroll:n.scrollWidth,client:n.clientWidth};}')
   check(f'{width}: composer fits viewport',fit['left']>=0 and fit['right']<=width+1 and fit['scroll']<=fit['client']+1,fit)
   for sel in ['.libra-input-writer-modal h2','.libra-input-writer-modal p','.libra-input-writer-modal textarea','.libra-input-writer-modal .sga-btn.primary']:
    c=page.evaluate(contrast,sel);check(f'{width}: readable {sel}',c['ratio']>=4.5,c)
   page.screenshot(path=str(E/f'{width}_composer.png'))
   page.keyboard.press('Escape');page.wait_for_function('!__writer.Runtime.inputWriterBusy')
  # Test actual choice generation via the production provider/preflight/normalizer.
  page.set_viewport_size({'width':1440,'height':1000})
  page.evaluate('__writerHost.click()')
  page.locator('.composer textarea').fill('문을 열지 않고 기다린다.')
  page.get_by_role('button',name='세 가지 후보 만들기',exact=True).click()
  page.locator('.libra-input-writer-modal.choices').wait_for(timeout=20000)
  check('one physical model call creates three candidates',page.evaluate('__writerHost.calls.model===1'),page.evaluate('__writerHost.calls'))
  check('original plus exactly three candidates',page.locator('.libra-input-writer-choice-grid textarea').count()==4)
  page.screenshot(path=str(E/'1440_choices.png'))
  check('no send before explicit selection',page.evaluate('__writerHost.calls.send.length===0'))
  page.locator('.libra-input-writer-choice-grid .sga-card').nth(1).locator('textarea').fill('선택 후 직접 고친 최종 입력입니다.')
  page.locator('.libra-input-writer-choice-grid .sga-card').nth(1).locator('button').click()
  page.locator('.libra-input-writer-modal.delivery').wait_for()
  check('exact edited candidate survives into delivery',page.locator('.delivery textarea').input_value()=='선택 후 직접 고친 최종 입력입니다.')
  page.screenshot(path=str(E/'1440_delivery.png'))
  page.get_by_role('button',name='바로 전송',exact=True).click()
  page.wait_for_function('!__writer.Runtime.inputWriterBusy',timeout=10000)
  check('explicit send receives exact text once',page.evaluate('__writerHost.calls.send')==['선택 후 직접 고친 최종 입력입니다.'])
  # Empty composer follows the same chooser, never selects a candidate itself.
  page.evaluate('__writerHost.click()')
  page.get_by_role('button',name='세 가지 후보 만들기',exact=True).click()
  page.locator('.libra-input-writer-modal.choices').wait_for(timeout=20000)
  check('empty input shows three alternatives without original',page.locator('.libra-input-writer-choice-grid textarea').count()==3)
  page.keyboard.press('Escape');page.wait_for_function('!__writer.Runtime.inputWriterBusy')
  check('cancelling choices does not send',page.evaluate('__writerHost.calls.send.length===1'))
  # A denied show RPC must not leave a busy, invisible modal behind.
  page.evaluate('__writerHost.showMode="reject";__writerHost.click()')
  page.wait_for_function('__writerHost.calls.errors.some(x=>x.includes("show denied"))')
  page.wait_for_function('!__writer.Runtime.inputWriterBusy')
  check('container denial releases modal and reports an error',page.evaluate('!__writer.Gui.confirmationVisible') and page.locator('.libra-input-writer-modal').count()==0)
  page.evaluate('__writerHost.showMode="normal"')
  # Settings and writer no longer silently suppress each other. Preserve draft.
  page.evaluate('__LIBRA__.openSettingsGui()')
  page.wait_for_function('__writer.Gui.state && !__writer.Gui.openHydrationPromise')
  page.evaluate('__writer.Gui.state.runtime.inputWriterMode="author";__writer.Gui.dirty=true;__writerHost.click()')
  page.locator('.libra-input-writer-modal.composer').wait_for()
  page.keyboard.press('Escape');page.wait_for_function('!__writer.Runtime.inputWriterBusy')
  check('opening from visible Settings restores unsaved draft on cancel',page.evaluate('__writer.Gui.visible && __writer.Gui.dirty && __writer.Gui.state.runtime.inputWriterMode==="author"'))
  check('no uncaught browser errors',not errors,errors)
  browser.close()
finally:
 (E/'RESULTS.json').write_text(json.dumps({'method':'production LIBRA in Chromium; host, model transport and chat storage are test doubles; not live RisuAI','passed':sum(x['ok'] for x in results),'total':len(results),'errors':errors,'results':results},ensure_ascii=False,indent=2))
 for r in results:print(('PASS ' if r['ok'] else 'FAIL ')+r['name'])
 print(json.dumps({'passed':sum(x['ok'] for x in results),'total':len(results),'errors':errors}))
