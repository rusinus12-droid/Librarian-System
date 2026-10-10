"""Full deployed RE:TRACE + real HTTP/SQLite; only the RisuAI host API is a test adapter.
Browser native-network restrictions are not bypassed: nativeFetch is explicitly
adapted to Python's loopback HTTP client, just as the host owns network I/O.
"""
from pathlib import Path
import subprocess,json,os,time,urllib.request,urllib.error,tempfile,shutil
from playwright.sync_api import sync_playwright
P=Path(__file__).resolve().parents[2]
OUT=Path(os.environ.get('PORTABLE_BROWSER_OUTPUT',tempfile.mkdtemp(prefix='portable-browser-results-')));OUT.mkdir(parents=True,exist_ok=True)
server=subprocess.Popen(['node',str(P/'tests/fixtures/portable_browser_servers.cjs')],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
data=json.loads(server.stdout.readline());checks=[];errors=[];calls=[]
def request(base,route,body=None,plugin='flashback_hayaku_bridge',token=None,epoch=None):
 headers={'Content-Type':'application/json','X-Memory-Suite-Plugin':plugin}
 if plugin=='flashback_hayaku_bridge':headers['X-Memory-Suite-Manager']='retrace'
 if token:headers['Authorization']='Bearer '+token
 if epoch:headers['X-Memory-Suite-Reset-Epochs']=json.dumps(epoch)
 req=urllib.request.Request(base+route,data=json.dumps(body).encode() if body is not None else None,headers=headers)
 try:r=urllib.request.urlopen(req,timeout=120)
 except urllib.error.HTTPError as e:r=e
 return r.status,json.loads(r.read())
def read_values(base):
 out={}
 for ns,plugin in [('flashback','flashback_memory'),('hayaku','hayaku_locator_continuity'),('libra','libra'),('lia','lia_persona_linker'),('retrace','flashback_hayaku_bridge')]:
  _,boot=request(base,'/bootstrap',plugin=plugin)
  route='/v1/kv/get?namespace='+ns+'&space=plugin&key=browser-snapshot-'+ns
  status,p=request(base,route,plugin=plugin,token=boot['token'],epoch=boot['resetEpochs']);assert status==200,(status,p);out[ns]=p['result']
 return out
try:
 with sync_playwright() as pw:
  browser=pw.chromium.launch(executable_path=os.environ.get('CHROME_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
  def page_for(base,width):
   page=browser.new_page(viewport={'width':width,'height':1000},accept_downloads=True)
   page.set_content('<html><head><meta charset="utf-8"></head><body></body></html>')
   page.on('pageerror',lambda e:errors.append(str(e)))
   def host_fetch(u,i):
    assert any(u.startswith(url+'/') for url in data['urls']);calls.append({'method':i.get('method','GET'),'route':u.split('/',3)[-1]})
    req=urllib.request.Request(u,data=i.get('body','').encode() if i.get('body') is not None else None,headers=i.get('headers',{}),method=i.get('method','GET'))
    try:r=urllib.request.urlopen(req,timeout=120)
    except urllib.error.HTTPError as e:r=e
    return {'status':r.status,'body':r.read().decode(),'headers':dict(r.headers)}
   page.expose_function('_hostFetch',host_fetch)
   page.evaluate('''url=>{const values=new Map();globalThis.risuai={apiVersion:'3.0',getArgument:async k=>k==='memory_suite_server_url'?url:k==='memory_suite_server_mode'?'plugin_only':null,setArgument:async()=>true,nativeFetch:async(u,i={})=>{const r=await globalThis._hostFetch(u,i);return new Response(r.body,{status:r.status,headers:r.headers})},pluginStorage:{getItem:async k=>values.get(k)??null,setItem:async(k,v)=>{values.set(k,v);return true},removeItem:async k=>{values.delete(k);return true},keys:async()=>[...values.keys()]},showContainer:async()=>true,hideContainer:async()=>true,registerSetting:async()=>true,registerButton:async()=>true,onUnload:async f=>globalThis.testUnload=f,getRuntimeInfo:async()=>({apiVersion:'3.0',platform:'web'}),getCharacter:async()=>({id:'test',chaId:'test',chatPage:0,chats:[{id:'chat',message:[]}]}),getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>0};}''',base)
   page.add_script_tag(content=(P/'plugins/RETRACE.js').read_text());page.wait_for_function('!!globalThis.__RETRACE');page.evaluate('globalThis.__RETRACE.showUi()')
   page.locator('#tab-serverdata').click();page.locator('[data-server-page="backups"]').first.click()
   page.wait_for_function('!document.querySelector("[data-portable-action=export]").disabled')
   return page
  a=page_for(data['urls'][0],1440)
  with a.expect_download(timeout=60000) as d:a.locator('[data-portable-action="export"]').click()
  archive=OUT/'browser-download.zip';d.value.save_as(archive)
  a.wait_for_function('document.querySelector("#portableTransferStatus").textContent.includes("SHA-256")');assert archive.stat().st_size>0
  checks.append('full_owner_export_download');a.screenshot(path=str(OUT/'retrace_export_1440.png'))
  before=read_values(data['urls'][1]);assert all(not row['exists'] for row in before.values())
  b=page_for(data['urls'][1],390);b.locator('#portableBackupFile').set_input_files(str(archive));b.locator('[data-portable-action="upload"]').click()
  b.wait_for_function('document.querySelector("#portableTransferStatus").textContent.includes("ZIP 검사와 가져오기가 완료")',timeout=60000)
  assert read_values(data['urls'][1])==before;checks.append('upload_inspection_no_live_mutation');b.screenshot(path=str(OUT/'retrace_import_390.png'))
  b.locator('[data-portable-action="restore"]').click();b.locator('#retraceDialogLayer').wait_for(state='visible');assert '빈 서버' in b.locator('#retraceDialogMessage').text_content();checks.append('empty_server_confirmation')
  b.locator('#retraceDialogCancel').click();assert read_values(data['urls'][1])==before;checks.append('cancel_does_not_restore')
  b.locator('[data-portable-action="restore"]').click();b.locator('#retraceDialogConfirm').click()
  b.wait_for_function('document.querySelector("#portableTransferStatus").textContent.includes("서버 데이터 복원 완료:")',timeout=60000)
  after=read_values(data['urls'][1]);assert all(r['exists'] and r['value']['owner']==ns for ns,r in after.items());checks.append('confirmed_restore_all_five_namespaces')
  assert '새로고침' in b.locator('#portableTransferStatus').text_content();checks.append('reconnect_not_claimed_automatically_complete');b.screenshot(path=str(OUT/'retrace_restored_390.png'))
  # Use a fresh plugin instance after restore: existing clients must reconnect.
  b.close();b=page_for(data['urls'][1],768);b.locator('#portableBackupFile').set_input_files(str(archive));b.locator('[data-portable-action="upload"]').click()
  b.wait_for_function('document.querySelector("#portableTransferStatus").textContent.includes("ZIP 검사와 가져오기가 완료")',timeout=60000)
  b.locator('[data-portable-action="restore"]').click();b.locator('#retraceDialogLayer').wait_for(state='visible')
  warning='기존에 사용하던 데이터가 있습니다. 복원 작업을 진행시 기존 데이터는 복원된 데이터로 대체됩니다. 데이터 폴더를 미리 보존하신 후 사용을 권장합니다. 복원을 시작하시겠습니까?'
  assert b.locator('#retraceDialogMessage').text_content()==warning;checks.append('exact_populated_server_warning');b.screenshot(path=str(OUT/'retrace_replace_warning_768.png'));b.locator('#retraceDialogCancel').click();assert read_values(data['urls'][1])==after;checks.append('populated_cancel_preserves_all_data')
  assert not errors,errors
  assert any('portable/upload-chunk' in c['route'] for c in calls);assert any('portable/download-chunk' in c['route'] for c in calls)
  checks.append('real_storage_sdk_http_routes')
  browser.close()
 result={'test':'portable_retrace_browser','passed':len(checks),'checks':checks,'pageErrors':errors,'boundary':'whole RE:TRACE plugin, Chromium File input/Blob download, synthetic RisuAI nativeFetch adapter to real local HTTP/SQLite; no real RisuAI installation'}
 (OUT/'RESULTS.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result,ensure_ascii=False))
finally:
 server.terminate()
 try:server.wait(timeout=30)
 except subprocess.TimeoutExpired:server.kill()
