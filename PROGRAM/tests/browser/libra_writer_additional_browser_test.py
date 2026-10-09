from pathlib import Path
from playwright.sync_api import sync_playwright
import json, shutil, sys
R=Path(sys.argv[1]) if len(sys.argv)>1 else Path(__file__).resolve().parents[2]
E=Path(sys.argv[2]) if len(sys.argv)>2 else R.parent.parent/'LIBRA_WRITER_ADDITIONAL'
E.mkdir(parents=True,exist_ok=True)
s=(R/'plugins/LIBRA.js').read_text();a='  const publicApi = Object.freeze({\n    getHostLineageStatus: () => LibraMemoryCore'
s=s.replace(a,'  globalThis.__writer={Gui,Runtime,loadSettings,showLibraInputWriterDeliveryPicker};\n'+a)
results=[];errors=[]
def check(n,y):
 results.append({'name':n,'ok':bool(y)})
 if not y:raise AssertionError(n)
with sync_playwright() as pw:
 browser=pw.chromium.launch(executable_path=shutil.which('chromium'),headless=True,args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':390,'height':844});page.on('pageerror',lambda e:errors.append(str(e)))
 page.set_content('<html lang="ko"><body style="margin:0"></body></html>');page.add_script_tag(content=(R/'tests/browser/libra_writer_host.js').read_text());page.add_script_tag(content=s)
 page.wait_for_function('!!window.__LIBRA__ && __writerHost.stores.chat.some(x=>x.id==="libra-input-writer-button")')
 try:
  page.evaluate('__writerHost.click()');page.locator('.composer').wait_for();page.evaluate('__writerHost.click()')
  check('duplicate entry keeps one composer',page.locator('.composer').count()==1)
  page.keyboard.press('Escape');page.wait_for_function('!__writer.Runtime.inputWriterBusy')
  # Old show acknowledgement cannot close the current surface.
  page.evaluate('__writerHost.showMode="pending";__writerHost.click()');page.locator('.composer').wait_for()
  page.keyboard.press('Escape');page.wait_for_function('!__writer.Runtime.inputWriterBusy')
  page.evaluate('__writerHost.showMode="normal";__writerHost.click()');page.locator('.composer').wait_for()
  hides=page.evaluate('__writerHost.calls.hide');page.evaluate('__writerHost.resolveShows()');page.wait_for_timeout(50)
  check('late old show does not hide a newer composer',page.evaluate('__writerHost.calls.hide')==hides and page.locator('.composer').is_visible())
  page.keyboard.press('Escape');page.wait_for_function('!__writer.Runtime.inputWriterBusy')
  # Generate through the actual provider path, then test multiple delivery outcomes.
  page.evaluate('__writerHost.click()');page.locator('.composer textarea').fill('문을 열지 않는다.');page.get_by_role('button',name='세 가지 후보 만들기').click()
  page.locator('.choices').wait_for(timeout=15000);page.screenshot(path=str(E/'390_choices.png'))
  check('390px choices have no horizontal overflow',page.locator('.choices').evaluate('(n)=>n.scrollWidth<=n.clientWidth+1 && n.getBoundingClientRect().right<=390'))
  page.locator('.libra-input-writer-choice-grid .sga-card').nth(1).locator('button').click();page.locator('.delivery').wait_for();page.screenshot(path=str(E/'390_delivery.png'))
  snapshot=page.evaluate('__writer.Runtime.lastInputWriter.deliverySnapshot')
  check('390px delivery has no horizontal overflow',page.locator('.delivery').evaluate('(n)=>n.scrollWidth<=n.clientWidth+1 && n.getBoundingClientRect().right<=390'))
  page.evaluate('''()=>{__writerHost.savedExec=document.execCommand;document.execCommand=()=>false;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('fixture clipboard denied');}}});}''')
  page.get_by_role('button',name='복사 후 직접 전송',exact=True).click();page.wait_for_function('!document.querySelector(".delivery .sga-btn.primary").disabled')
  check('blocked copy keeps editable text and cancel',page.locator('.delivery textarea').is_editable() and '전달 실패' in page.locator('.delivery .sga-input-confirm-status').inner_text())
  check('blocked copy does not send',page.evaluate('__writerHost.calls.send.length===0'))
  page.evaluate('''()=>{navigator.clipboard.writeText=async value=>{__writerHost.copied=value;};}''')
  page.locator('.delivery textarea').fill('복사할 정확한 편집문입니다.');page.get_by_role('button',name='복사 후 직접 전송',exact=True).click();page.wait_for_function('!__writer.Runtime.inputWriterBusy')
  check('copy uses final edited text without sending',page.evaluate('__writerHost.copied')=='복사할 정확한 편집문입니다.' and page.evaluate('__writerHost.calls.send.length===0'))
  # Native setter unavailable -> copy fallback, never claim real insertion.
  page.evaluate('(snapshot)=>{__writerHost.extra=__writer.showLibraInputWriterDeliveryPicker({content:"삽입 대체 복사문",deliverySnapshot:snapshot,runId:"insert-unavailable"});}',snapshot)
  page.locator('.delivery').wait_for();page.get_by_role('button',name='입력창에 넣기',exact=True).click();page.wait_for_function('!__writer.Gui.confirmationVisible')
  receipt=page.evaluate('__writerHost.extra')
  check('missing insert API uses honest manual fallback',receipt.get('action')=='copy_for_insert' and receipt.get('accepted')==False and page.evaluate('__writerHost.calls.send.length===0'))
  # Source revision changed -> no automatic send, copy still possible.
  page.evaluate('__writerHost.chat.message.push({role:"user",data:"다른 장소로 이동했다.",chatId:"new-user"},{role:"char",data:"새로운 장소다.",chatId:"new-answer"})')
  page.evaluate('(snapshot)=>{__writerHost.extra=__writer.showLibraInputWriterDeliveryPicker({content:"오래된 후보",deliverySnapshot:snapshot,runId:"stale"});}',snapshot)
  page.locator('.delivery').wait_for();page.get_by_role('button',name='바로 전송',exact=True).click();page.wait_for_function('!document.querySelector(".delivery .sga-btn.primary").disabled')
  check('changed source prevents send and keeps editor',page.evaluate('__writerHost.calls.send.length===0') and '차단' in page.locator('.delivery .sga-input-confirm-status').inner_text())
  page.keyboard.press('Escape');page.wait_for_function('!__writer.Gui.confirmationVisible')
  # Missing showContainer capability reports failure, releases busy, no provider.
  page.evaluate('__writerHost.savedShow=risuai.showContainer;delete risuai.showContainer;__writerHost.click()')
  page.wait_for_function('!__writer.Runtime.inputWriterBusy && __writerHost.calls.errors.some(x=>x.includes("표시할 수 없습니다"))')
  check('missing show API does not leave invisible busy session',page.locator('.composer').count()==0)
  check('no unhandled script errors',not errors)
 finally:
  (E/'RESULTS.json').write_text(json.dumps({'method':'production plugin / ephemeral host + clipboard transport fixtures','passed':sum(r['ok'] for r in results),'total':len(results),'errors':errors,'results':results},ensure_ascii=False,indent=2))
  for r in results:print(('PASS 'if r['ok']else'FAIL ')+r['name'])
  print(errors)
  browser.close()
