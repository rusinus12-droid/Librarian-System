"""Round 9 actual deployed JS/DOM. Only host/model transport and export seams are synthetic."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json,sys,shutil
R=Path(sys.argv[1]);E=Path(sys.argv[2]);E.mkdir(parents=True,exist_ok=True)
s=(R/'plugins/LIBRA.js').read_text();anchor='  const publicApi = Object.freeze({\n    getHostLineageStatus: () => LibraMemoryCore'
assert s.count(anchor)==1
s=s.replace(anchor,'  globalThis.__consumerGui={Gui,Runtime,loadSettings,bookOpenQuickSettings,closeBookQuickSettings,selectBookSettingsRoomSection,showLibraInputWriterDeliveryPicker};\n'+anchor)
host=(Path(__file__).parent/'libra_writer_host.js').read_text();results=[];errors=[]
def check(n,v,details=None):
 results.append({'name':n,'ok':bool(v),'details':details});print(('PASS 'if v else'FAIL ')+n,flush=True)
 if not v:raise AssertionError(n+': '+str(details))
try:
 with sync_playwright() as p:
  b=p.chromium.launch(executable_path=shutil.which('chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage']);page=b.new_page(viewport={'width':1440,'height':1000});page.on('pageerror',lambda e:errors.append(str(e)));page.on('dialog',lambda d:d.dismiss())
  page.set_content('<!doctype html><html lang="ko"><meta charset="utf-8"><body style="margin:0"></body></html>');page.add_script_tag(content=host);page.add_script_tag(content=s)
  page.wait_for_function('window.__LIBRA__ && __writerHost.stores.chat.length>0')
  page.evaluate("__LIBRA__.saveLibraProviderConfig({responseFamily:'gradia',gradiaWritingMode:'author',inputWriterMode:'rp'})")
  page.evaluate('__LIBRA__.openSettingsGui()');page.wait_for_function('__consumerGui.Gui.state && !__consumerGui.Gui.openHydrationPromise')
  page.evaluate("__consumerGui.bookOpenQuickSettings('input_writer')")
  page.locator('[data-consumer-policy-group="input_writer"]').wait_for()
  check('quick Input Writer is independently RP while GRADIA is Author',page.evaluate('__consumerGui.Gui.state.runtime.inputWriterMode==="rp" && __consumerGui.Gui.state.runtime.gradiaWritingMode==="author"'))
  for w in [1440,1024,768,390]:
   page.set_viewport_size({'width':w,'height':1000 if w>600 else 844});page.wait_for_timeout(100)
   drawer=page.locator('.libra-book-drawer');r=drawer.evaluate('(n)=>({left:n.getBoundingClientRect().left,right:n.getBoundingClientRect().right,scroll:n.scrollWidth,client:n.clientWidth})')
   check(f'{w}: consumer policy and mode drawer fits',r['left']>=-1 and r['right']<=w+1 and r['scroll']<=r['client']+1,r)
   check(f'{w}: actual policy displays default no auto extra',page.locator('[data-consumer-policy-group="input_writer"] select').first.input_value()=='0')
   check(f'{w}: independent mode choice available',page.locator('.libra-book-drawer .libra-book-tool-choice-grid.two').count()>0)
   page.screenshot(path=str(E/f'consumer_policy_{w}.png'))
  # Actual stored policy round trip, same UI readback rather than display-only data.
  page.locator('[data-consumer-policy-group="input_writer"] select').first.select_option('1')
  page.locator('.libra-book-drawer-actions').get_by_role('button',name='저장',exact=True).click()
  page.wait_for_function('!__consumerGui.Gui.dirty');cfg=page.evaluate('__LIBRA__.getLibraProviderConfig()')
  check('policy dropdown saves one shared extra without changing modes',cfg['responseConsumerPolicy']['extraCalls']['input_writer']==1 and cfg['inputWriterMode']=='rp' and cfg['gradiaWritingMode']=='author')
  page.locator('.libra-book-drawer-actions').get_by_role('button',name='닫기',exact=True).click()
  page.evaluate("__consumerGui.selectBookSettingsRoomSection('input_writer')")
  page.locator('#sga-stage-input_assist').wait_for()
  check('detailed GRADIA-side Input Writer exposes its independent mode controls',page.locator('#sga-stage-input_assist .sga-simple-choice-grid.two').count()>=2)
  page.evaluate("__LIBRA__.saveLibraProviderConfig({responseConsumerPolicy:{schema:'libra.response_consumer_policy.v1',extraCalls:{input_writer:0}}})")
  # Controlled partial result from the actual button: no third-choice refill.
  page.evaluate("""window.__baseModel=risuai.runLLMModel;risuai.runLLMModel=async args=>{const out=JSON.parse(await __baseModel(args));out.choices[2].input='';return JSON.stringify(out);};__writerHost.click()""")
  page.locator('.composer textarea').fill('문은 열지 않고 이유만 묻는다.');before=page.evaluate('__writerHost.calls.model');page.get_by_role('button',name='세 가지 후보 만들기',exact=True).click()
  page.locator('.libra-input-writer-modal.choices').wait_for(timeout=20000)
  check('partial two candidates plus source kept',page.locator('.libra-input-writer-choice-grid textarea').count()==3)
  check('partial status not a false complete result', '부분 결과' in page.locator('.choices h2').locator('..').inner_text())
  check('partial creates no automatic refill call',page.evaluate('__writerHost.calls.model')==before+1)
  page.screenshot(path=str(E/'partial_candidates_390.png'))
  page.locator('.libra-input-writer-choice-grid .sga-card').nth(1).locator('button').click();page.locator('.delivery').wait_for()
  original=page.locator('.delivery textarea').input_value()
  # Translation promise held open: editable source must survive a late translation.
  page.evaluate("""risuai.runLLMModel=async args=>{__writerHost.calls.model++;window.__translationArgs=args;return await new Promise(resolve=>window.__resolveTranslation=resolve);};true;""")
  page.get_by_role('button',name='영어로 번역',exact=True).click();page.wait_for_function('!!window.__resolveTranslation')
  page.locator('.delivery textarea').fill('번역 대기 중 새로 고친 문장.');page.evaluate("__resolveTranslation('The old text was translated.');__resolveTranslation=null")
  page.wait_for_function('!__LIBRA__.getResponseConsumerOperations().input_translation.hostPending');page.wait_for_timeout(100)
  check('late translation cannot overwrite edited source',page.locator('.delivery textarea').input_value()=='번역 대기 중 새로 고친 문장.')
  check('translation source revision warning visible','SOURCE_CHANGED' in page.locator('.delivery .sga-input-confirm-status').inner_text())
  # A second explicit translation can be logically cancelled without waiting for host.
  page.get_by_role('button',name='영어로 번역',exact=True).click();page.wait_for_function('!!window.__resolveTranslation')
  check('cancel remains enabled while translation is pending',page.locator('.delivery').get_by_role('button',name='취소',exact=True).is_enabled())
  page.locator('.delivery').get_by_role('button',name='취소',exact=True).click();page.wait_for_function('!__consumerGui.Runtime.inputWriterBusy')
  check('logical cancel releases modal but reports physical pending',page.locator('.delivery').count()==0 and page.evaluate('__LIBRA__.getResponseConsumerOperations().input_translation.hostPending'))
  page.evaluate("__resolveTranslation('Late cancelled translation.');__resolveTranslation=null")
  page.wait_for_function('!__LIBRA__.getResponseConsumerOperations().input_translation.hostPending')
  check('late cancelled host response is discarded and settled',page.evaluate('__LIBRA__.getResponseConsumerOperations().input_translation.attempts[0].status')=='late_result_discarded')
  check('no automatic send from partial selection, translation or cancellation',page.evaluate('__writerHost.calls.send.length')==0)
  check('no uncaught browser errors',not errors,errors);b.close()
finally:
 (E/'RESULTS.json').write_text(json.dumps({'method':'actual deployment JS+Chromium DOM; controlled host/model; not real RisuAI','passed':sum(x['ok'] for x in results),'total':len(results),'results':results,'errors':errors},ensure_ascii=False,indent=2))
 for r in results:print(('PASS 'if r['ok']else'FAIL ')+r['name'])
 print(json.dumps({'passed':sum(x['ok'] for x in results),'total':len(results),'errors':errors}))
