"""Runs the shipped HAYAKU source in Chromium with an ephemeral RisuAI boundary.
No user data, real host, or external LLM is used. Hooks exist in browser memory
only and do not alter the plugin saved in PROGRAM/plugins.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json, math, sys, os, shutil
R=Path(sys.argv[1]) if len(sys.argv)>1 else Path(__file__).resolve().parents[2]
E=Path(sys.argv[2]) if len(sys.argv)>2 else R.parent.parent/'HAYAKU_GUI_VERIFICATION'
E.mkdir(parents=True,exist_ok=True)
source=(R/'plugins/HAYAKU_Locator_Continuity.js').read_text()
anchor='  await install();'
assert source.count(anchor)==1
source=source.replace(anchor,'''  globalThis.__hvg = {Memory, RisuCompat, viewerSetTab, viewerRenderOverview, viewerRenderPacketAuthoring, viewerRenderSourceEditConsent, viewerRenderHostLineage, viewerRenderWorldline, getHayakuSourceEdits};
'''+anchor)
host=(Path(__file__).parent/'hayaku_browser_host.js').read_text()
results=[];errors=[]
def check(name,condition,detail=None):
    results.append({'name':name,'ok':bool(condition),'detail':detail})
    if not condition: raise AssertionError(f'{name}: {detail}')
geometry="""(id) => {const n=document.querySelector(id),r=n.getBoundingClientRect(),p=n.parentElement.getBoundingClientRect(),s=getComputedStyle(n);return {width:r.width,height:r.height,top:r.top,bottom:r.bottom,left:r.left,right:r.right,parentLeft:p.left,parentRight:p.right,scroll:n.scrollWidth,client:n.clientWidth,font:s.fontSize,line:s.lineHeight,display:s.display};}"""
contrast="""(selector)=>{const n=document.querySelector(selector),s=getComputedStyle(n),rgb=x=>(x.match(/[\\d.]+/g)||[]).map(Number);let p=n,bg;while(p){const c=rgb(getComputedStyle(p).backgroundColor);if(c.length===3||c[3]>=.99){bg=c;break;}p=p.parentElement;}bg=bg||[255,255,255];const fg=rgb(s.color);const lum=c=>c.slice(0,3).map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((a,x,i)=>a+x*[.2126,.7152,.0722][i],0);const a=lum(fg),b=lum(bg);return {ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),fg,bg};}"""
try:
 with sync_playwright() as p:
  executable=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('chromium-browser')
  browser=p.chromium.launch(**({'executable_path':executable} if executable else {}),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
  page=browser.new_page(viewport={'width':1440,'height':1000})
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.set_content('<!doctype html><html lang="ko"><meta charset="utf-8"><body style="margin:0"></body></html>')
  page.add_script_tag(content=host);page.add_script_tag(content=source)
  page.wait_for_function('!!window.HAYAKU',timeout=30000)
  page.evaluate('HAYAKU.showUi()')
  page.wait_for_function('!!document.querySelector(".hayaku-viewer") && !__hvg.Memory.ledgerViewer.busy',timeout=30000)
  page.wait_for_timeout(100)
  check('actual plugin startup',page.evaluate('HAYAKU.version')==source.split('//@version ',1)[1].splitlines()[0].strip())
  for width in [1440,1024,768,390]:
   page.set_viewport_size({'width':width,'height':1000 if width>600 else 844})
   def goto(tab):
    page.locator(f'[data-hayaku-viewer-tab="{tab}"]').click();page.wait_for_timeout(120)
    check(f'{width}: actual sidebar selects {tab}',page.evaluate('(t)=>__hvg.Memory.ledgerViewer.activeTab===t',tab))
   goto('overview')
   page.evaluate('''()=>{__hvg.Memory.lastBeforeRequest=null;__hvg.viewerRenderOverview();}''')
   author=page.evaluate(geometry,'#hayakuPacketAuthoring');title=page.evaluate(geometry,'#hayakuPacketAuthoringTitle');empty=page.evaluate(geometry,'#hayakuPacketAuthoring .hv-scope-empty')
   metric=page.locator('#hayakuOverviewOrphans').evaluate('(n)=>n.closest(".hv-overview-metrics").getBoundingClientRect().bottom')
   check(f'{width}: authoring below the final metrics',author['top']>=metric-1)
   check(f'{width}: authoring title is one horizontal line',title['height']<=float(title['line'].removesuffix('px'))+1,title)
   check(f'{width}: empty observation is below title',empty['top']>=title['bottom'])
   check(f'{width}: no source/lineage cards inside overview',page.locator('#hayakuViewerPanelOverview #hayakuSourceEditConsent,#hayakuViewerPanelOverview #hayakuHostLineage').count()==0)
   if width in [1440,390]:
    page.locator('#hayakuPacketAuthoring').scroll_into_view_if_needed();page.screenshot(path=str(E/f'{width}_overview_empty.png'))
   page.evaluate('''()=>{const m=__hvg.Memory,key=m.ledgerViewer.scope.key;m.lastBeforeRequest={scopeKey:key,at:Date.now(),packetWriteActive:true,requestLineage:{requestNonce:'browser-nonce'},outputContract:{packetPlacement:{mode:'inside_terminal_wrapper',closingTag:'</Story>'}},staticWriteChars:18000,runtimeSkeletonChars:2100,terminalSealChars:740};m.lastPacketAuthoringObservation={scopeKey:key,requestNonce:'browser-nonce',at:Date.now()+1,result:'valid_packet_awaiting_binding'};m.lastStorageCapture={scopeKey:key,requestNonce:'browser-nonce',at:Date.now()+2,durable:true,packetCount:1};__hvg.viewerRenderPacketAuthoring();}''')
   check(f'{width}: authored request observation is shown',page.locator('#hayakuPacketAuthoring').inner_text().find('메인 응답 모델에 적용')>=0)
   check(f'{width}: write/binding distinction retained','활성 결속은 별도' in page.locator('#hayakuPacketAuthoring').inner_text())
   check(f'{width}: escaped closing tag is text, not markup','</Story> 직전' in page.locator('#hayakuPacketAuthoring').inner_text())
   for sel in ['#hayakuPacketAuthoring','#hayakuPacketAuthoring .hv-scope-kv']:
    r=page.evaluate(geometry,sel);check(f'{width}: {sel} width fits',r['right']<=r['parentRight']+1 and r['left']>=r['parentLeft']-1 and r['scroll']<=r['client']+1,r)
   for sel in ['#hayakuPacketAuthoringTitle','#hayakuPacketAuthoring dt','#hayakuPacketAuthoring dd']:
    c=page.evaluate(contrast,sel);check(f'{width}: contrast {sel}',c['ratio']>=4.5,c)
   if width==1440:
    page.locator('#hayakuPacketAuthoring').scroll_into_view_if_needed();page.screenshot(path=str(E/'1440_overview_records.png'))
   goto('recovery')
   check(f'{width}: source edits visible only in Recovery',page.locator('#hayakuViewerPanelRecovery #hayakuSourceEditConsent').is_visible())
   page.evaluate('''()=>__hvg.viewerRenderSourceEditConsent({scopeKey:__hvg.Memory.ledgerViewer.scope.key,tasks:[{label:'T8',state:'declined',stateLabel:'보류'},{label:'T9',state:'failed',stateLabel:'재처리 실패',error:'원문 재검증 필요'}]})''')
   check(f'{width}: task states below source-edit heading','확인 필요 2건' in page.locator('#hayakuSourceEditConsent').inner_text())
   check(f'{width}: actual review action is styled',page.locator('#reviewHayakuSourceEdits').evaluate('(n)=>n.classList.contains("hv-btn") && typeof n.onclick==="function"'))
   for sel in ['#hayakuSourceEditConsent','#hayakuSourceEditConsent .hv-scope-badge','#reviewHayakuSourceEdits']:
    r=page.evaluate(geometry,sel);check(f'{width}: {sel} fits',r['right']<=r['parentRight']+1 and r['scroll']<=r['client']+1,r)
   for sel in ['#hayakuSourceEditConsentTitle','#hayakuSourceEditConsent .hv-scope-badge','#reviewHayakuSourceEdits']:
    c=page.evaluate(contrast,sel);check(f'{width}: contrast {sel}',c['ratio']>=4.5,c)
   if width in [1440,390]:
    page.locator('#hayakuSourceEditConsent').scroll_into_view_if_needed();page.screenshot(path=str(E/f'{width}_recovery.png'))
   # Test a long failed task without leaking HTML or overflowing the card.
   page.evaluate('''()=>__hvg.viewerRenderSourceEditConsent({scopeKey:__hvg.Memory.ledgerViewer.scope.key,tasks:[{label:'T10',state:'failed',error:'<img src=x onerror="window.__xss=1">'+('LONG_REVISION_'.repeat(100))}]})''')
   check(f'{width}: task content escaped',page.locator('#hayakuSourceEditConsent img').count()==0 and page.evaluate('window.__xss||0')==0)
   r=page.evaluate(geometry,'#hayakuSourceEditConsent');check(f'{width}: long task value wraps',r['scroll']<=r['client']+1,r)
   goto('worldline')
   check(f'{width}: lineage and packet timeline share the Worldline panel',page.locator('#hayakuViewerPanelWorldline #hayakuHostLineage').is_visible() and page.locator('#hayakuViewerPanelWorldline #hayakuWorldlineTimeline').is_visible())
   page.evaluate('''()=>{const m=__hvg.Memory,s=m.ledgerViewer.scope;s.hostLineage={schema:'librarian.host_lineage.v1',hostChatId:s.chatId,kind:'native_branch',status:'verified',parentName:'검증용 부모 채팅',parentChatId:'parent-test-chat',forkMessageId:'turn10-assistant',commonPrefixPairs:5,commonPrefixMessages:10,path:['parent-test-chat',s.chatId],pathVerified:false,pathReason:'ancestor_evidence_missing',reason:'exact_host_branch_prefix'};__hvg.viewerRenderHostLineage();}''')
   h=page.locator('#hayakuHostLineage').inner_text()
   check(f'{width}: verified prefix does not mean full path/inheritance',all(t in h for t in ['공통 원문 검증됨','5 U+A턴 / 10개 메시지','전체 경로 미검증','확인은 별도']))
   for sel in ['#hayakuHostLineage','#hayakuHostLineage .hv-scope-badge']:
    r=page.evaluate(geometry,sel);check(f'{width}: {sel} fits',r['right']<=r['parentRight']+1 and r['scroll']<=r['client']+1,r)
   c=page.evaluate(contrast,'#hayakuHostLineage .hv-scope-badge');check(f'{width}: verified badge contrast',c['ratio']>=4.5,c)
   if width in [1440,390]:
    page.locator('#hayakuHostLineage').scroll_into_view_if_needed();page.screenshot(path=str(E/f'{width}_worldline.png'))
   page.evaluate('''()=>{__hvg.Memory.ledgerViewer.scope.hostLineage.parentChatId='PATH_LONG_'.repeat(80);__hvg.Memory.ledgerViewer.scope.hostLineage.path=['PATH_LONG_'.repeat(80),'gui-chat-A'];__hvg.viewerRenderHostLineage();}''')
   r=page.evaluate(geometry,'#hayakuHostLineage');check(f'{width}: long lineage identifier wraps',r['scroll']<=r['client']+1,r)
   check(f'{width}: single instance of each moved component',all(page.locator(i).count()==1 for i in ['#hayakuPacketAuthoring','#hayakuSourceEditConsent','#hayakuHostLineage']))
  check('zero external model/network calls while rendering and navigating',page.evaluate('__hostCalls.llm===0&&__hostCalls.network===0'),page.evaluate('__hostCalls'))
  check('no browser script errors',not errors,errors)
  browser.close()
finally:
 (E/'GUI_BROWSER_RESULTS.json').write_text(json.dumps({'method':'full production plugin in Chromium; ephemeral host API and injected presentation state; not a live RisuAI/model test','passed':sum(r['ok'] for r in results),'total':len(results),'errors':errors,'results':results},ensure_ascii=False,indent=2))
 for r in results: print(('PASS ' if r['ok'] else 'FAIL ')+r['name'])
 print(json.dumps({'passed':sum(r['ok'] for r in results),'total':len(results),'errors':errors}))
