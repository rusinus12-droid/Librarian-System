"""Full deployed RE:TRACE + real HTTP/SQLite; only the RisuAI host API is a test adapter.
Browser native-network restrictions are not bypassed: nativeFetch is explicitly
adapted to Python's loopback HTTP client, just as the host owns network I/O.
"""
from pathlib import Path
import subprocess,json,os,time,urllib.request,urllib.error,tempfile,shutil,asyncio,hashlib,re
from playwright.sync_api import sync_playwright
P=Path(__file__).resolve().parents[2]
PRODUCT_PATH=Path(os.environ.get('PORTABLE_BROWSER_PRODUCT_PATH',P/'plugins/RETRACE.js'))
PRODUCT_SOURCE=PRODUCT_PATH.read_text();PRODUCT_SHA=hashlib.sha256(PRODUCT_SOURCE.encode()).hexdigest()
OUT=Path(os.environ.get('PORTABLE_BROWSER_OUTPUT',tempfile.mkdtemp(prefix='portable-browser-results-')));OUT.mkdir(parents=True,exist_ok=True)
server=subprocess.Popen(['node',str(P/'tests/fixtures/portable_browser_servers.cjs')],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
data=json.loads(server.stdout.readline());checks=[];errors=[];calls=[];view_metrics=[];view_landmarks=[];diagnostics_checks=[];dialog_landmarks=[];job_landmarks=[];host_geometry=[];reference_geometry={}
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
 for ns,plugin in [('flashback','flashback_memory'),('hayaku','hayaku_locator_continuity'),('libra','libra')]:
  _,boot=request(base,'/bootstrap',plugin=plugin)
  route='/v1/kv/get?namespace='+ns+'&space=plugin&key=browser-snapshot-'+ns
  status,p=request(base,route,plugin=plugin,token=boot['token'],epoch=boot['resetEpochs']);assert status==200,(status,p);out[ns]=p['result']
 return out
try:
 with sync_playwright() as pw:
  browser=pw.chromium.launch(executable_path=os.environ.get('CHROME_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
  def check_host_geometry(page,width,route):
   if width not in reference_geometry:
    reference=(P/'docs/gui-redesign/retrace.html').read_text()
    reference=re.sub(r'<script[\s\S]*?</script>','',reference)
    for name in ['suite.css','themes.css']:
     reference=reference.replace('<link rel="stylesheet" href="assets/'+name+'">','<style>'+(P/'docs/gui-redesign/assets'/name).read_text()+'</style>')
    ref=browser.new_page(viewport={'width':width,'height':1000});ref.set_content(reference)
    ref.evaluate("document.querySelector('.proto-bar').remove()")
    reference_geometry[width]=ref.evaluate("()=>({top:document.querySelector('.frame').getBoundingClientRect().top,width:document.querySelector('.frame').getBoundingClientRect().width,canvas:getComputedStyle(document.body).backgroundColor})")
    ref.screenshot(path=str(OUT/f'reference_public_geometry_{width}.png'));ref.close()
   actual=page.evaluate("()=>({top:document.querySelector('.frame').getBoundingClientRect().top,width:document.querySelector('.frame').getBoundingClientRect().width,canvas:getComputedStyle(document.querySelector('#flashback-hayaku-bridge-root')).backgroundColor})")
   evidence={'viewport':width,'route':route,'actual':actual,'reference':reference_geometry[width]};host_geometry.append(evidence);print('PUBLIC_FULL_HOST_GEOMETRY',evidence,flush=True)
   assert actual==reference_geometry[width],evidence
  def page_for(base,width):
   page=browser.new_page(viewport={'width':width,'height':1000},accept_downloads=True)
   page.add_init_script('delete window.showSaveFilePicker')
   page.set_content('<html><head><meta charset="utf-8"></head><body></body></html>')
   page.on('pageerror',lambda e:errors.append(str(e)))
   def host_fetch(u,i):
    assert any(u.startswith(url+'/') for url in data['urls']);calls.append({'method':i.get('method','GET'),'route':u.split('/',3)[-1]})
    if '/restore/execute' in u or '/portable/restore' in u or '/v1/manager/reset/execute' in u:time.sleep(0.8)
    elif '/portable/' in u:time.sleep(0.2)
    req=urllib.request.Request(u,data=i.get('body','').encode() if i.get('body') is not None else None,headers=i.get('headers',{}),method=i.get('method','GET'))
    try:r=urllib.request.urlopen(req,timeout=120)
    except urllib.error.HTTPError as e:r=e
    return {'status':r.status,'body':r.read().decode(),'headers':dict(r.headers)}
   async def host_fetch_async(u,i):
    return await asyncio.to_thread(host_fetch,u,i)
   page.expose_function('_hostFetch',host_fetch_async)
   page.evaluate('''url=>{const values=new Map();globalThis.risuai={apiVersion:'3.0',getArgument:async k=>k==='memory_suite_server_url'?url:k==='memory_suite_server_mode'?'plugin_only':null,setArgument:async()=>true,nativeFetch:async(u,i={})=>{const r=await globalThis._hostFetch(u,i);return new Response(r.body,{status:r.status,headers:r.headers})},pluginStorage:{getItem:async k=>values.get(k)??null,setItem:async(k,v)=>{values.set(k,v);return true},removeItem:async k=>{values.delete(k);return true},keys:async()=>[...values.keys()]},showContainer:async()=>true,hideContainer:async()=>true,registerSetting:async()=>true,registerButton:async()=>true,onUnload:async f=>globalThis.testUnload=f,getRuntimeInfo:async()=>({apiVersion:'3.0',platform:'web'}),getCharacter:async()=>({id:'test',chaId:'test',chatPage:0,chats:[{id:'chat',message:[]}]}),getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>0};}''',base)
   page.add_script_tag(content=PRODUCT_SOURCE);page.wait_for_function('!!globalThis.__RETRACE');page.evaluate('globalThis.__RETRACE.showUi()')
   page.wait_for_function('document.querySelectorAll("#overviewBody .relay__node").length===4&&document.querySelectorAll("#overviewBody .stats .stat").length===4')
   print('HOST_WIDTH_OVERRIDE_COMPARISON',page.evaluate('''()=>{const style=document.querySelector('[data-retrace-host-overrides]'),stage=document.querySelector('.stage');const enabled=stage.getBoundingClientRect().width;style.sheet.disabled=true;const disabled=stage.getBoundingClientRect().width;style.sheet.disabled=false;return {viewport:innerWidth,withOverride:enabled,withoutOverride:disabled}}'''),flush=True)
   page.screenshot(path=str(OUT/f'retrace_overview_{width}.png'));check_host_geometry(page,width,'overview')
   page.evaluate('''()=>{const m=document.querySelector('[data-menu]');m.click();if(!m.closest('.menu').classList.contains('is-open'))throw new Error('overflow menu failed to open');document.querySelector('#closeBridge').closest('.menu').querySelector('[data-menu]').click();if(m.closest('.menu').classList.contains('is-open'))throw new Error('overflow menu failed to close');}''')
   diag='.tabbar [data-tab="diagnostics"]' if width<=900 else '#tab-diagnostics'
   sessionnav='.tabbar [data-tab="session"]' if width<=900 else '#tab-session'
   page.locator(sessionnav).click();page.wait_for_function('document.querySelectorAll("#sessionPreflight .check-item").length===4');page.screenshot(path=str(OUT/f'retrace_session_{width}.png'));check_host_geometry(page,width,'session')
   page.locator(diag).click();page.wait_for_function('document.querySelectorAll("#diagnosticsBody .check-item").length===4');page.screenshot(path=str(OUT/f'retrace_diagnostics_{width}.png'));check_host_geometry(page,width,'diagnostics')
   assert '42ms' not in page.locator('#diagnosticsBody').text_content()
   before_diagnose=len(calls);page.locator('[data-diagnose-now]').click();page.wait_for_function('document.querySelector("#serverControlDiagnosis").textContent.includes("확인 완료")',timeout=60000);assert len(calls)>before_diagnose
   before_again=len(calls);page.locator('[data-diagnose-now]').click();page.wait_for_function('document.querySelector("#serverControlDiagnosis").textContent.includes("확인 완료")',timeout=60000);assert len(calls)>before_again
   page.locator('#diagnosticsBody [data-retrace-goto="serverdata"]').click();assert page.locator('[data-server-view="data"]').is_visible()
   dialogs=page.evaluate('''()=>({nextTwo:!!document.querySelector('#dlg-next .two'),nextLia:!!document.querySelector('#dlg-next .note'),retryKv:!!document.querySelector('#dlg-retry .kv'),deleteTwo:!!document.querySelector('#dlg-del .two'),deleteWarning:!!document.querySelector('#dlg-del .note--danger'),restoreKv:document.querySelectorAll('#dlg-restore .kv dt').length,restoreWarning:!!document.querySelector('#dlg-restore .note--danger'),resetKv:document.querySelectorAll('#dlg-reset .kv dt').length,resetWarning:!!document.querySelector('#dlg-reset .note--danger')})''')
   dialog_landmarks.append({'viewport':width,**dialogs});diagnostics_checks.append({'viewport':width,'freshReadClicks':2,'serverDataShortcut':True})
   assert dialogs=={'nextTwo':True,'nextLia':True,'retryKv':True,'deleteTwo':True,'deleteWarning':True,'restoreKv':3,'restoreWarning':True,'resetKv':2,'resetWarning':True},dialogs
   jobs=page.evaluate('''()=>Object.fromEntries(['next','del','backup','restore','reset'].map(kind=>{const n=document.querySelector('#job-'+kind);return [kind,{steps:n.querySelectorAll('[data-job-steps] .step').length,results:n.querySelectorAll('[data-job-result]').length,hints:n.querySelectorAll('.hint').length,wide:n.querySelector('.dialog').classList.contains('dialog--wide')}]}))''')
   assert {kind:value['steps'] for kind,value in jobs.items()}=={'next':4,'del':4,'backup':3,'restore':3,'reset':4},jobs
   assert jobs['del']['hints']==1 and jobs['backup']['hints']==1 and jobs['reset']['hints']==2
   assert not jobs['backup']['wide'] and all(jobs[k]['wide'] for k in ['next','del','restore','reset'])
   job_landmarks.append({'viewport':width,'jobs':jobs})
   nav='.tabbar [data-tab="serverdata"]' if width<=900 else '#tab-serverdata'
   page.locator(nav).click()
   page.locator(nav).click();page.locator('[data-server-page="backups"]').first.click()
   page.wait_for_function('!document.querySelector("[data-portable-action=export]").disabled')
   for view in ['overview','data','backups','connection','history']:
    page.locator('.tabs [data-server-page="'+view+'"]').click()
    assert page.locator('[data-server-view="'+view+'"]').is_visible()
    page.screenshot(path=str(OUT/f'retrace_server_{view}_{width}.png'));check_host_geometry(page,width,'server-'+view)
   canonical=page.evaluate('''()=>({serverStats:document.querySelectorAll('#serverControlSummary .stat').length,serverOwners:document.querySelectorAll('#serverControlPlugins .owner').length,kinds:document.querySelectorAll('#serverScopeKinds .kind').length,connectionChecks:document.querySelectorAll('#serverControlDiagnosis .check-item').length,historyBanner:!!document.querySelector('[data-server-view=history] .banner--info'),historyList:document.querySelector('#serverControlHistory').tagName,backupCards:document.querySelectorAll('[data-server-view=backups]>.stack>.card').length,backupReset:!!document.querySelector('[data-server-view=backups] .danger-zone'),dataReset:!!document.querySelector('[data-server-view=data] .danger-zone'),sessionChecks:document.querySelectorAll('#sessionPreflight .check-item').length,diagnoseAction:!!document.querySelector('[data-diagnose-now]')})''')
   assert canonical=={'serverStats':4,'serverOwners':4,'kinds':6,'connectionChecks':2,'historyBanner':True,'historyList':'DIV','backupCards':2,'backupReset':True,'dataReset':False,'sessionChecks':4,'diagnoseAction':True},canonical
   page.locator('.tabs [data-server-page="data"]').click();page.locator('[data-server-scope-filter="unverified"]').click();assert page.locator('[data-server-scope-filter="unverified"]').get_attribute('aria-pressed')=='true'
   page.locator('[data-server-scope-filter=""]').click();page.locator('.tabs [data-server-page="backups"]').click()
   page.screenshot(path=str(OUT/f'retrace_backups_{width}.png'))
   landmarks=page.evaluate('''()=>({relay:document.querySelectorAll('#overviewBody .relay__node').length,stats:document.querySelectorAll('#overviewBody .stats .stat').length,owners:document.querySelectorAll('#overviewBody .owner').length,diagnostics:document.querySelectorAll('#diagnosticsBody .check-item').length,unhydratedIcons:document.querySelectorAll('i[data-i]').length,sideFooters:document.querySelectorAll('.sidebar .side-foot').length})''')
   assert landmarks=={'relay':4,'stats':4,'owners':6,'diagnostics':4,'unhydratedIcons':0,'sideFooters':1},landmarks
   view_landmarks.append({'viewport':width,**landmarks})
   view_metrics.append(page.evaluate('''()=>{const q=s=>document.querySelector(s),r=e=>e?.getBoundingClientRect().toJSON();const selects=[...document.querySelectorAll('select')];return {viewport:innerWidth,stageWidth:r(q('.stage'))?.width,frameWidth:r(q('.frame'))?.width,appWidth:r(q('.app'))?.width,horizontalOverflow:document.documentElement.scrollWidth>innerWidth,tabbar:getComputedStyle(q('.tabbar')).display,unlabeledSelects:selects.filter(x=>!x.getAttribute('aria-label')&&!x.labels?.length&&!x.getAttribute('aria-labelledby')).map(x=>x.id)}}'''))
   return page
  a=page_for(data['urls'][0],1440)
  try:
   with a.expect_download(timeout=20000) as d:a.locator('[data-portable-action="export"]').click()
   archive=OUT/'browser-download.zip';d.value.save_as(archive)
  except Exception:
   print('EXPORTDEBUG',a.evaluate('''()=>({button:document.querySelector('[data-portable-action=export]')?.outerHTML,status:document.querySelector('#portableTransferStatus')?.textContent,job:document.querySelector('#job-backup')?.outerHTML.slice(-1000),savePicker:typeof window.showSaveFilePicker,storage:!!navigator.storage?.getDirectory})'''),errors)
   raise
  a.wait_for_function('document.querySelector("#portableTransferStatus").textContent.includes("SHA-256")');assert archive.stat().st_size>0
  a.locator('#job-backup').wait_for(state='visible');a.screenshot(path=str(OUT/'retrace_export_job_1440.png'));a.locator('#job-backup [data-job-hide]').click()
  checks.append('full_owner_export_download');a.screenshot(path=str(OUT/'retrace_export_1440.png'))
  second_archive=OUT/'browser-download-second.zip'
  with a.expect_download(timeout=20000) as d2:
   a.locator('[data-portable-action="export"]').click()
   a.wait_for_function('!document.querySelector("#job-backup .progress").hidden&&document.querySelector("#job-backup [data-job-result]").hidden&&document.querySelector("#job-backup [data-job-hide]").textContent.includes("숨기기")')
   a.screenshot(path=str(OUT/'retrace_export_job_fresh_after_completed_1440.png'))
  d2.value.save_as(second_archive);a.wait_for_function('document.querySelector("#portableTransferStatus").textContent.includes("SHA-256")');a.locator('#job-backup [data-job-hide]').click()
  checks.append('completed_job_restarts_with_fresh_progress')
  before=read_values(data['urls'][1]);assert all(not row['exists'] for row in before.values())
  b=page_for(data['urls'][1],390);b.locator('#portableBackupCard details summary').click();b.locator('#portableBackupFile').set_input_files(str(archive));b.locator('[data-portable-action="upload"]').click()
  b.locator('#job-backup').wait_for(state='visible');assert b.locator('#job-backup .progress').is_visible() and b.locator('#job-backup [data-job-result]').is_hidden();b.locator('#job-backup [data-job-hide]').click();b.locator('[data-job-tray]').wait_for(state='visible');b.locator('[data-job-tray]').click();b.locator('#job-backup').wait_for(state='visible');assert b.evaluate('''()=>{const p=document.querySelector('#job-backup .progress').hidden,r=document.querySelector('#job-backup [data-job-result]').hidden;return p!==r}''');checks.append('job_hide_and_reopen');b.screenshot(path=str(OUT/'retrace_upload_job_reopened_390.png'))
  b.wait_for_function('document.querySelector("#portableTransferStatus").textContent.includes("ZIP 검사와 가져오기가 완료")',timeout=60000)
  b.locator('#job-backup').wait_for(state='visible');b.screenshot(path=str(OUT/'retrace_upload_job_390.png'));b.locator('#job-backup [data-job-hide]').click()
  assert read_values(data['urls'][1])==before;checks.append('upload_inspection_no_live_mutation');b.screenshot(path=str(OUT/'retrace_import_390.png'))
  b.locator('[data-portable-action="restore"]').click();b.locator('#dlg-restore').wait_for(state='visible');assert '빈 서버' in b.locator('#dlg-restore [data-dialog-message]').text_content();checks.append('empty_server_confirmation')
  b.screenshot(path=str(OUT/'retrace_restore_confirm_390.png'));b.locator('#dlg-restore [data-dialog-cancel]').click();assert read_values(data['urls'][1])==before;checks.append('cancel_does_not_restore')
  b.locator('[data-portable-action="restore"]').click();b.locator('#dlg-restore [data-dialog-typed-input]').fill('복원');b.locator('#dlg-restore [data-dialog-confirm]').click()
  b.locator('#job-restore').wait_for(state='visible');b.locator('#job-restore [data-job-hide]').click();b.locator('[data-job-tray]').click();b.locator('#job-restore').wait_for(state='visible');assert b.locator('#job-restore [data-job-steps] .step').count()==3;checks.append('restore_job_hide_reopen_keeps_operation_context');b.screenshot(path=str(OUT/'retrace_restore_job_390.png'))
  b.wait_for_function('document.querySelector("#portableTransferStatus").textContent.includes("서버 데이터 복원 완료:")',timeout=60000);b.locator('#job-restore [data-job-response-fold] summary').click();b.keyboard.press('Tab');assert b.evaluate('document.activeElement===document.querySelector("#job-restore [data-job-hide]")');b.keyboard.press('Shift+Tab');assert b.evaluate('document.activeElement===document.querySelector("#job-restore [data-job-response-fold] summary")');print('RECEIPT_OVERFLOW_METRICS',b.evaluate("()=>[document.querySelector('#job-restore .dialog'),...document.querySelectorAll('#job-restore .dialog *')].filter(n=>n.scrollWidth>n.clientWidth+1).map(n=>({tag:n.tagName,class:n.className,field:n.dataset.jobField,text:n.textContent.slice(0,100),client:n.clientWidth,scroll:n.scrollWidth,width:getComputedStyle(n).width,columns:getComputedStyle(n).gridTemplateColumns,whiteSpace:getComputedStyle(n).whiteSpace}))"));assert b.evaluate('document.querySelector("#job-restore .dialog").scrollWidth<=document.querySelector("#job-restore .dialog").clientWidth');checks.append('canonical_receipt_disclosure_keyboard_and_mobile_wrap');b.screenshot(path=str(OUT/'retrace_restore_receipt_open_390.png'));b.locator('#job-restore [data-job-hide]').click()
  assert b.locator('#job-restore [data-job-result] .res').count()==2
  assert '미확인' not in b.locator('#job-restore [data-job-result]').text_content()
  after=read_values(data['urls'][1]);assert all(r['exists'] and r['value']['owner']==ns for ns,r in after.items());checks.append('confirmed_restore_all_three_remote_writer_namespaces')
  assert '새로고침' in b.locator('#portableTransferStatus').text_content();checks.append('reconnect_not_claimed_automatically_complete');b.screenshot(path=str(OUT/'retrace_restored_390.png'))
  # Synthetic Chromium source-layout boundary captures after real runtime registration.
  c=page_for(data['urls'][1],900);c.screenshot(path=str(OUT/'retrace_runtime_shell_900.png'));c.close()
  d=page_for(data['urls'][1],640);d.screenshot(path=str(OUT/'retrace_runtime_shell_640.png'));d.close()
  # Use a fresh plugin instance after restore: existing clients must reconnect.
  b.close();b=page_for(data['urls'][1],768);b.locator('#portableBackupCard details summary').click();b.locator('#portableBackupFile').set_input_files(str(archive));b.locator('[data-portable-action="upload"]').click()
  b.wait_for_function('document.querySelector("#portableTransferStatus").textContent.includes("ZIP 검사와 가져오기가 완료")',timeout=60000)
  b.locator('#job-backup').wait_for(state='visible');b.locator('#job-backup [data-job-hide]').click()
  b.locator('[data-portable-action="restore"]').click();b.locator('#dlg-restore').wait_for(state='visible')
  warning='기존에 사용하던 데이터가 있습니다. 복원 작업을 진행시 기존 데이터는 복원된 데이터로 대체됩니다. 데이터 폴더를 미리 보존하신 후 사용을 권장합니다. 복원을 시작하시겠습니까?'
  assert b.locator('#dlg-restore [data-dialog-message]').text_content()==warning;checks.append('exact_populated_server_warning');b.screenshot(path=str(OUT/'retrace_replace_warning_768.png'));b.locator('#dlg-restore [data-dialog-cancel]').click();assert read_values(data['urls'][1])==after;checks.append('populated_cancel_preserves_all_data')
  assert not errors,errors
  b.locator('.tabs [data-server-page="backups"]').click()
  b.locator('#serverResetTarget').select_option('hayaku')
  b.locator('#serverResetBegin').click();b.locator('#dlg-reset').wait_for(state='visible')
  assert b.locator('#dlg-reset [data-dialog-summary-value]').text_content()=='hayaku'
  b.screenshot(path=str(OUT/'retrace_reset_confirm_768.png'))
  b.locator('#dlg-reset [data-dialog-typed-input]').fill('초기화')
  assert not b.locator('#dlg-reset [data-dialog-confirm]').is_disabled()
  b.locator('#dlg-reset [data-dialog-confirm]').click()
  b.locator('#job-reset').wait_for(state='visible');b.locator('#job-reset [data-job-hide]').click();b.locator('[data-job-tray]').click();b.locator('#job-reset').wait_for(state='visible');assert b.locator('#job-reset [data-job-steps] .step').count()==4 and 'hayaku' in b.locator('#job-reset h2').text_content();checks.append('reset_job_hide_reopen_keeps_selected_owner')
  b.wait_for_function('document.querySelector("#serverResetStatus").textContent.includes("초기화 및 빈 상태 확인 완료")',timeout=60000)
  b.locator('#job-reset').wait_for(state='visible');b.screenshot(path=str(OUT/'retrace_reset_job_768.png'))
  assert b.locator('#job-reset [data-job-result] .res').count()==2
  assert 'hayaku' in b.locator('#job-reset [data-job-result]').text_content() and '빈 상태를 서버 API' in b.locator('#job-reset [data-job-result]').text_content()
  reset_values=read_values(data['urls'][1])
  assert not reset_values['hayaku']['exists'] and reset_values['libra']==after['libra'] and reset_values['flashback']==after['flashback'],reset_values
  checks.append('typed_reset_selected_owner_fresh_readback_preserves_other_owners')
  b.locator('#job-reset [data-job-hide]').click()
  assert [m['viewport'] for m in view_metrics]==[1440,390,900,640,768],view_metrics
  assert all(not m['horizontalOverflow'] and not m['unlabeledSelects'] for m in view_metrics),view_metrics
  expected={1440:1200,390:362,900:872,640:612,768:740}
  assert all(m['frameWidth']==expected[m['viewport']] for m in view_metrics),view_metrics
  assert next(m for m in view_metrics if m['viewport']==1440)['tabbar']=='none'
  assert all(next(m for m in view_metrics if m['viewport']==width)['tabbar']=='grid' for width in [900,640,768,390]),view_metrics
  assert any('portable/upload-chunk' in c['route'] for c in calls);assert any('portable/download-chunk' in c['route'] for c in calls)
  checks.append('real_storage_sdk_http_routes')
  browser.close()
 result={'test':'portable_retrace_browser','productSourceSHA256':PRODUCT_SHA,'productPath':str(PRODUCT_PATH),'publicHostGeometry':host_geometry,'passed':len(checks),'checks':checks,'pageErrors':errors,'runtimeViewportMetrics':view_metrics,'runtimePageLandmarks':view_landmarks,'runtimeDiagnosticsActions':diagnostics_checks,'canonicalConfirmationLandmarks':dialog_landmarks,'canonicalJobLandmarks':job_landmarks,'canonicalInnerViews':['Overview','Next Session','Server Overview','Server Data','Backups','Connection','History','Diagnostics'],'boundary':'whole RE:TRACE plugin, Chromium File input/Blob download, synthetic RisuAI nativeFetch adapter to real local HTTP/SQLite; no real RisuAI installation'}
 (OUT/'RESULTS.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result,ensure_ascii=False))
finally:
 server.terminate()
 try:server.wait(timeout=30)
 except subprocess.TimeoutExpired:server.kill()
