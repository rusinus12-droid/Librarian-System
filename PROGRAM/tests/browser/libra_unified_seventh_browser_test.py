#!/usr/bin/env python3
"""Production LIBRA+GUI+real HTTP/SQLite, synthetic RisuAI and model boundary."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json, shutil, subprocess, sys, time, urllib.request, urllib.error, hashlib
P=Path(sys.argv[1]).resolve();E=Path(sys.argv[2]).resolve();E.mkdir(parents=True,exist_ok=True)
artifact=json.loads(subprocess.check_output(['node','-e','console.log(JSON.stringify(require(process.argv[1]).artifact()))',str(P/'tests/fixtures/libra_unified_runtime_fixture.cjs')]))
source=json.loads((P/'tests/fixtures/unified_vertical_source.json').read_text())
s=(P/'plugins/LIBRA.js').read_text();needle='  const publicApi = Object.freeze({\n    getHostLineageStatus: () => LibraMemoryCore';assert needle in s
s=s.replace(needle,'  globalThis.__wm={Gui,LibraMemoryCore,renderSettingsGui,bookSelectPeopleSection,bookSelectSettingsWorkbench};\n'+needle)
results=[];errors=[];complete=False

def check(n,v,d=None):
 results.append({'name':n,'ok':bool(v),'detail':d})
 if not v:raise AssertionError(n+': '+str(d))
def close_jobs(p):
 p.wait_for_function('()=>!__wm.Gui.canonicalJobRenderTimer')
 for n in p.locator('.canonical-job-overlay').all():
  if n.is_visible():n.get_by_role('button',name='닫기',exact=True).click()
def panel(p):
 p.evaluate('async()=>await __LIBRA__.openSettingsGui()');close_jobs(p)
 p.evaluate('()=>{__wm.Gui.settingsHubSection="memory";__wm.bookSelectSettingsWorkbench("settings");}')
 p.wait_for_selector('[data-unified-storage-status]')

def page(browser,url,mode):
 p=browser.new_page(viewport={'width':1440,'height':1100});p.set_default_timeout(20000);p.on('pageerror',lambda e:errors.append(str(e)))
 # This container blocks browser navigation/network by policy. Model the host
 # nativeFetch RPC with an explicit Python loopback bridge; storage remains the
 # real unmodified HTTP/SQLite server. Do not call this a real RisuAI test.
 def native_fetch(u,i):
  if not u.startswith(url+'/'):raise ValueError('test bridge rejects non-test-server request')
  req=urllib.request.Request(u,data=i.get('body','').encode() if i.get('body') is not None else None,headers=i.get('headers',{}),method=i.get('method','GET'))
  try:
   with urllib.request.urlopen(req,timeout=10) as r:return {'status':r.status,'body':r.read().decode(),'headers':dict(r.headers)}
  except urllib.error.HTTPError as e:return {'status':e.code,'body':e.read().decode(),'headers':dict(e.headers)}
 p.expose_function('__nativeServerBridge',native_fetch)
 p.expose_function('__sha256Bridge',lambda b:list(hashlib.sha256(bytes(b)).digest()))
 p.set_content('<html lang="ko"><body></body></html>');p.add_script_tag(content=(P/'tests/browser/libra_writer_host.js').read_text())
 p.evaluate('''({url,mode,source,artifact})=>{
  __writerHost.chat.message=source.sourceRows.map(r=>({role:r.role,chatId:r.ref,data:r.text}));__writerHost.chat.messages=__writerHost.chat.message;__writerHost.artifact=artifact;
  const c=__writerHost.character,h=__writerHost.chat;__writerHost.values.set('libra:v1:scope-registry:v1',JSON.stringify({[c.id+'::'+h.id]:{scopeKey:'seventh-browser-'+mode,characterId:c.id,chatId:h.id,source:'explicit_existing_scope'}}));
  const old=risuai.getArgument;risuai.getArgument=async k=>k.includes('memory_suite_server_mode')?mode:k.includes('memory_suite_server_url')?url:['enable_character_ito','enable_world_ito','enable_plot_ito'].some(x=>k.includes(x))?'false':old(k);
  if(!crypto.subtle)Object.defineProperty(crypto,'subtle',{value:{digest:async(a,b)=>{if(a!=='SHA-256')throw Error('test digest algorithm unsupported');return new Uint8Array(await __sha256Bridge(Array.from(new Uint8Array(b.buffer||b,b.byteOffset||0,b.byteLength)))).buffer;}}});
  __writerHost.requests=[];risuai.nativeFetch=async(u,i)=>{__writerHost.requests.push({url:u,method:i?.method,body:i?.body});const r=await __nativeServerBridge(u,i||{});return new Response(r.body,{status:r.status,headers:r.headers});};
  risuai.runLLMModel=async()=>{__writerHost.calls.model++;return {type:'success',result:JSON.stringify(__writerHost.artifact)}};
 }''',{'url':url,'mode':mode,'source':source,'artifact':artifact})
 p.add_script_tag(content=s);p.wait_for_function('!!window.__LIBRA__');return p

log=(E/'backend.log').open('w');backend=subprocess.Popen(['node',str(P/'tests/browser/libra_server_browser_backend.cjs'),str(E)],stdout=log,stderr=subprocess.STDOUT)
try:
 for _ in range(200):
  if (E/'server.json').exists():break
  if backend.poll() is not None:raise RuntimeError('backend exited')
  time.sleep(.02)
 url=json.loads((E/'server.json').read_text())['url']
 with sync_playwright() as pw:
  b=pw.chromium.launch(executable_path=shutil.which('chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
  p=page(b,url,'server_only');panel(p);p.get_by_role('button',name='통합 저장 지원 확인',exact=True).click();p.wait_for_function('document.querySelector("[data-unified-storage-result]").dataset.status==="supported"')
  text=p.locator('[data-unified-storage-result]').inner_text();check('GUI identifies bounded server-only scope, not mirror/distributed support','서버 전용' in text and '차단' in text,text)
  check('read-only support check does not call model',p.evaluate('__writerHost.calls.model')==0)
  await_status=p.evaluate('async()=>await __LIBRA__.getUnifiedStorageStatus()');check('status does not claim real host/model validation',await_status['actualHostValidated'] is False and await_status['externalModelValidated'] is False)
  p.evaluate('async()=>await __LIBRA__.saveLibraMemorySettings({...await __LIBRA__.getLibraMemorySettings(),memoryEngine:"unified",stateTrackingEnabled:false})')
  out=p.evaluate('async()=>await __LIBRA__.runManualColdStart()');check('public 5-turn job stores real server canonical and state',out.get('completed')==1,out)
  close_jobs(p);p.evaluate('async()=>await __LIBRA__.retryPendingUnifiedVectors()')
  check('SQLite batches are used by actual browser SDK',p.evaluate('()=>__writerHost.requests.filter(r=>r.url.endsWith("/v1/kv/batch")).length')>=2)
  check('no local duplicate canonical or Head written in server-only',p.evaluate('()=>![...__writerHost.values.keys()].some(k=>k.includes(":continuity-state")||/:memory:/.test(k))'))
  p.evaluate('async()=>await __LIBRA__.openSettingsGui()');close_jobs(p);p.evaluate('__wm.bookSelectPeopleSection("characters")')
  check('current people display actual server data','민아' in p.locator('body').inner_text())
  h=p.evaluate('()=>__wm.LibraMemoryCore.peekSnapshot().continuityState');person=next(x for x in h['characters'] if x['name']=='민아')
  correction=p.evaluate('async id=>await __LIBRA__.addWorldManagerCorrection({anchorTurn:5,target:{domain:"characters"},patch:{characters:[{id,set:{condition:"서버 교정 확인"}}]}})',person['id']);check('public correction commits journal and Head atomically',correction.get('ok') is True,correction.get('error'))
  p.evaluate('async()=>{__wm.Gui.invalidations.add("body");await __wm.renderSettingsGui();}')
  check('BOOK_UX shows corrected current server state','서버 교정 확인' in p.locator('body').inner_text())
  panel(p);p.get_by_role('button',name='통합 저장 지원 확인',exact=True).click();p.wait_for_function('document.querySelector("[data-unified-storage-result]").dataset.status==="supported"')
  for width in [1440,390]:
   p.set_viewport_size({'width':width,'height':1100});p.wait_for_timeout(80);p.locator('[data-unified-storage-status]').scroll_into_view_if_needed();p.screenshot(path=str(E/f'server_support_{width}.png'))
   check(f'storage status fits {width}px',p.locator('[data-unified-storage-status]').evaluate('(n)=>n.getBoundingClientRect().right<=innerWidth+1&&n.scrollWidth<=n.clientWidth+1'))
  check('correction and support queries did not add model calls',p.evaluate('__writerHost.calls.model')==1)
  p.close()
  p=page(b,url,'mirror');panel(p);p.get_by_role('button',name='통합 저장 지원 확인',exact=True).click();p.wait_for_function('document.querySelector("[data-unified-storage-result]").dataset.status==="blocked"')
  check('GUI keeps mirror unsupported',p.evaluate('document.querySelector("[data-unified-storage-result]").dataset.mode')=='mirror')
  check('blocked check performs no batch write or model',p.evaluate('()=>__writerHost.calls.model===0&&!__writerHost.requests.some(r=>r.url.endsWith("/v1/kv/batch"))'))
  p.close();check('zero browser script errors',not errors,errors);complete=True;b.close()
finally:
 backend.terminate()
 try:backend.wait(timeout=10)
 except subprocess.TimeoutExpired:backend.kill();backend.wait()
 log.close();r={'test':'libra_unified_seventh_browser','completed':complete,'boundary':'production JS/GUI; Python nativeFetch and SHA-256 bridge to actual local HTTP/SQLite; synthetic host/model, not actual RisuAI','passed':sum(x['ok'] for x in results),'total':len(results),'errors':errors,'results':results};(E/'RESULTS.json').write_text(json.dumps(r,ensure_ascii=False,indent=2));print(json.dumps({k:v for k,v in r.items() if k!='results'},ensure_ascii=False))
