"""Full LIBRA/GRADIA renderers in the default host's shared vertical panel slot.

The fixture reproduces the public RisuAI panel wrapper and trimmed SafeElement
events. Native host sanitization is checked separately; no models or user data.
Artifacts stay outside the repository by default.
"""
import asyncio,json,os
from pathlib import Path
from playwright.async_api import async_playwright

ROOT=Path(__file__).resolve().parents[3]
OUT=Path(os.environ.get('CHAT_STATUS_BROWSER_OUTPUT','/tmp/libra-gradia-chat-status-browser-20261017'))
HOST=r'''(() => {
 const store=new Map(),unload=[],listeners=new Map();let serial=0;
 window.__networkCalls=0;window.__panelWrites=[];
 const wrap=element=>element&&({
  getBoundingClientRect:async()=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};},
  addEventListener:async(type,callback)=>{const id=String(++serial);const target=window.__delegated?document:element;const listener=event=>callback({clientX:event.clientX,clientY:event.clientY,type:event.type});target.addEventListener(type,listener);listeners.set(id,{target,type,listener});return id;},
  removeEventListener:async(type,id)=>{const row=listeners.get(id);if(row){row.target.removeEventListener(row.type,row.listener);listeners.delete(id);}}
 });
 window.__listeners=listeners;
 const storage={getItem:async k=>store.get(k),setItem:async(k,v)=>store.set(k,v),removeItem:async k=>store.delete(k)};
 window.risuai={getArgument:async()=>undefined,setArgument:async()=>{},pluginStorage:storage,localPluginStorage:storage,
 addRisuReplacer:async()=>true,addRisuScriptHandler:async()=>true,requestPluginPermission:async()=>true,
 onUnload:async callback=>unload.push(callback),getCharacter:async()=>null,getDatabase:async()=>({characters:[]}),getChatFromIndex:async()=>null,getCurrentCharacterIndex:async()=>-1,getCurrentChatIndex:async()=>-1,
 fetch:async()=>{window.__networkCalls++;throw Error('NETWORK FORBIDDEN');},showContainer:async()=>{},hideContainer:async()=>{},registerSetting:async()=>true,registerButton:async()=>true,
 getRootDocument:async()=>({getElementById:async id=>wrap(document.getElementById(id)),querySelector:async s=>wrap(document.querySelector(s))}),
 setChatPanel:async(html,options={})=>{window.__panelWrites.push({id:options.id,visible:!!html});let section=document.querySelector('[data-plugin-chat-panel="'+options.id+'"]');if(!html){section?.remove();return;}if(!section){section=document.createElement('section');section.dataset.pluginChatPanel=options.id;document.getElementById('panels').appendChild(section);}section.className='host-panel '+(options.className||'');section.innerHTML=html;}
 };
})();'''

def product_source(name):
 source=(ROOT/'PROGRAM/plugins'/f'{name}.js').read_text()
 marker='  const publicApi = Object.freeze({'
 if name=='LIBRA':
  marker+='\n    getHostLineageStatus: () => LibraMemoryCore'
  expose='''globalThis.__statusLibra={Runtime, panel:PipelineWorkPanel,
   begin:()=>updatePipelineWorkPanel('Librarian이 TURN 26~30 메모리를 처리하고 있습니다…','libra_memory_preparing',{begin:true,source:'libra_memory'}),
   step:()=>updatePipelineWorkPanel('기억 생성 완료 · 저장된 정본에 상태를 반영하고 있습니다…','libra_state'),
   finish:()=>finishPipelineWorkStatus('TURN 26~30 기억 생성 완료 · 정본 저장 및 상태 반영 완료',true,60000,'completed')};\n'''
 else:
  expose='''globalThis.__statusGradia={Runtime,panel:InputAssistContinuePanel,
   begin:()=>updatePipelineWorkPanel('인물 AIDE가 최신 초안을 분석하고 필요한 문단만 수정하고 있습니다… (2/4)','stage_patch',{begin:true}),
   step:()=>updatePipelineWorkPanel('GRADIA 초안 작성 완료 · 응답 모델이 장면을 완성하고 있습니다…','awaiting_response'),
   finish:()=>finishPipelineWorkStatus('응답 작성이 완료되었습니다.',true,60000),
   writer:async()=>{InputAssistContinuePanel.begin();Runtime.inputAssistSend={requestId:(Runtime.inputAssistSend?.requestId||0)+1,busy:true,phase:'generating',cancelRequested:false};await setInputAssistContinuePanel('직전 장면을 바탕으로 이어질 인풋을 작성하고 있습니다…','working',0,true);}};\n'''
 assert source.count(marker)==1,(name,'fixture observation marker')
 return source.replace(marker,expose+marker,1)

async def main():
 OUT.mkdir(parents=True,exist_ok=True)
 reports=[]
 async with async_playwright() as pw:
  browser=await pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
  for width,height in [(1440,900),(390,844)]:
   for delegated in [False,True]:
    page=await browser.new_page(viewport={'width':width,'height':height})
    page.set_default_timeout(10000)
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    await page.set_content('''<!doctype html><html lang="ko"><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{height:100%;margin:0}body{background:#0b101b;color:#dce5f5;font-family:system-ui,sans-serif}.chat{height:100%;max-width:1100px;margin:auto;display:flex;flex-direction:column-reverse;overflow:auto;position:relative}.input{flex:none;margin:0 16px 8px;height:54px;background:#171f2e;border:1px solid #56627a;border-radius:9px;color:#dce5f5;padding:12px}#panels{margin:8px 16px;display:flex;flex-direction:column;gap:8px}.host-panel{padding:12px;border:1px solid #48536c;background:#121825;border-radius:6px}.messages{padding:20px 16px;min-height:180px;color:#8a9bb9;font-size:13px}</style><div class="chat"><textarea class="input" aria-label="메시지 입력" placeholder="메시지 입력"></textarea><div id="panels"></div><div class="messages">채팅 메시지 영역 · LIBRA / GRADIA 상태 표시줄</div></div></html>''')
    await page.evaluate(HOST)
    await page.evaluate('(value)=>window.__delegated=value',delegated)
    await page.add_script_tag(content=product_source('LIBRA'))
    await page.add_script_tag(content=product_source('GRADIA'))
    await page.wait_for_function('window.__statusLibra&&window.__statusGradia')
    await page.evaluate('async()=>{await __statusLibra.begin();await __statusGradia.begin();}')
    await page.wait_for_function('__listeners.size===2')
    measurements=await page.locator('[data-plugin-chat-panel]').evaluate_all('rows=>rows.map(e=>{const r=e.getBoundingClientRect();return {height:r.height,top:r.top,bottom:r.bottom,padding:getComputedStyle(e).padding};})')
    expected=40 if width>520 else 42
    assert all(abs(row['height']-expected)<.1 for row in measurements),measurements
    assert measurements[1]['top']-measurements[0]['bottom']==8
    assert all(row['padding']=='0px' for row in measurements)
    assert await page.locator('details[open]').count()==0
    await page.get_by_role('textbox').click()
    assert await page.locator('[data-plugin-chat-panel]').count()==2,'outside click must not close delegated buttons'
    await page.get_by_role('button',name='LIBRA 상태 표시 닫기').click()
    await page.locator('.libra-pipeline-status').wait_for(state='detached')
    assert await page.locator('.gradia-input-assist-status').count()==1
    assert await page.evaluate('__statusLibra.Runtime.pipelineWorkStatus.busy') is True,'closing only hides presentation'
    await page.evaluate('async()=>{await __statusLibra.step();await __statusLibra.finish();}')
    assert await page.locator('.libra-pipeline-status').count()==0,'terminal update must respect manual dismissal'
    assert await page.evaluate('__statusLibra.Runtime.pipelineWorkStatus.ok') is True
    await page.get_by_role('button',name='GRADIA 상태 표시 닫기').focus()
    await page.keyboard.press('Enter')
    await page.locator('.gradia-input-assist-status').wait_for(state='detached')
    await page.evaluate('async()=>{await __statusGradia.step();await __statusGradia.finish();}')
    assert await page.locator('[data-plugin-chat-panel]').count()==0
    await page.evaluate('async()=>{await __statusLibra.begin();await __statusLibra.finish();await __statusGradia.begin();}')
    await page.wait_for_function('__listeners.size===2')
    assert await page.locator('details[open]').count()==0,'result details remain collapsed'
    if not delegated:
     await page.screenshot(path=str(OUT/f'compact-{width}.png'))
     await page.locator('#panels').screenshot(path=str(OUT/f'bars-{width}.png'))
    await page.get_by_label('LIBRA 작업 상세 펼치기').click()
    assert await page.locator('.libra-pipeline-status details[open]').count()==1
    assert await page.locator('.libra-pipeline-status .mscs-body').is_visible()
    assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    await page.evaluate('__statusGradia.writer()')
    await page.wait_for_function('__listeners.size===3')
    assert await page.get_by_role('button',name='GRADIA 전송 취소').is_visible()
    await page.get_by_role('button',name='GRADIA 상태 표시 닫기').click()
    await page.locator('.gradia-input-assist-status').wait_for(state='detached')
    assert await page.evaluate('__statusGradia.Runtime.inputAssistSend.cancelRequested') is False
    await page.evaluate('__statusGradia.writer()')
    await page.wait_for_function('__listeners.size===3')
    await page.wait_for_timeout(350) # existing cancellation control's arming interval
    await page.get_by_role('button',name='GRADIA 전송 취소').click()
    await page.wait_for_function('__statusGradia.Runtime.inputAssistSend.cancelRequested===true')
    assert await page.get_by_role('button',name='GRADIA 상태 표시 닫기').is_visible()
    await page.evaluate('async()=>{await __statusLibra.panel.dispose();await __statusGradia.panel.dispose();}')
    # GRADIA's cancel binding is removed by the next own panel update/unload.
    assert await page.locator('[data-plugin-chat-panel]').count()==0
    assert await page.evaluate('__networkCalls')==0
    assert not errors,errors
    reports.append({'width':width,'delegatedEvents':delegated,'collapsedHeight':expected,'gap':8,'manualDismissSticky':True,'keyboardClose':True,'cancelSeparate':True,'networkCalls':0})
    await page.close()
  await browser.close()
 (OUT/'results.json').write_text(json.dumps(reports,ensure_ascii=False,indent=2))
 print(json.dumps({'passed':len(reports),'results':reports,'output':str(OUT)},ensure_ascii=False))

asyncio.run(main())
